"use client";

/**
 * Settings → Data subscriptions (plan 29).
 *
 * Browse admin-curated data bundles (prospect lists + company databases)
 * and subscribe/unsubscribe. Subscribing copies the bundle's prospects
 * into your contacts via the fill-empty merge (chunked apply loop with
 * progress); staying subscribed keeps them silently in sync. On mount,
 * stale subscriptions self-sync opportunistically — toast only on failure.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Database, Users, Building2, Check, RefreshCw } from "lucide-react";

interface BundleRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  prospect_count: number;
  company_count: number;
  published_at: string | null;
}

interface SubscriptionRow {
  id: number;
  bundle_id: number;
  status: string;
  synced_version: number;
  last_synced_at: string | null;
}

interface ApplyProgress {
  applied: number;
  total: number;
}

type ApplyStep = {
  done: boolean;
  nextCursor: { phase: "apply" | "remove"; afterId: number } | null;
  pinnedVersion: number;
  applied: number;
  claimToken?: string;
};

const BACKGROUND_SYNC_MESSAGE =
  "The sync hit a server error. It will keep running in the background — your contacts will appear shortly.";

/**
 * POST one cursor-loop step. A 5xx (e.g. a function timeout's 504, whose
 * body is HTML rather than JSON) or a network failure is retried twice with
 * backoff before giving up (CAR-47); null means all attempts failed.
 * `retried` marks a step that only succeeded after a server error — a 409
 * on such a step usually means the failed call's claim is still held, not
 * that another driver is genuinely syncing.
 */
async function fetchStepWithRetry<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; step: T & { error?: string }; retried: boolean } | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status < 500) {
        return { res, step: (await res.json()) as T & { error?: string }, retried: attempt > 0 };
      }
    } catch {
      // Network failure or non-JSON body — treated like a 5xx.
    }
    if (attempt >= 2) return null;
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

export default function DataSubscriptionsSection() {
  const { user } = useAuth();
  const { success, error: toastError } = useToast();
  const supabase = createSupabaseBrowserClient();

  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<Map<number, SubscriptionRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Map<number, ApplyProgress>>(new Map());
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<BundleRow | null>(null);
  const [unsubscribeChoice, setUnsubscribeChoice] = useState<"keep" | "remove">("keep");
  const [unsubscribing, setUnsubscribing] = useState(false);
  const selfSyncStarted = useRef(false);

  const load = useCallback(async () => {
    if (!user) return { bundles: [] as BundleRow[], subs: new Map<number, SubscriptionRow>() };
    const [{ data: bundleRows }, { data: subRows }] = await Promise.all([
      supabase
        .from("data_bundles")
        .select("id, slug, name, description, version, prospect_count, company_count, published_at")
        .order("published_at", { ascending: false }),
      supabase
        .from("bundle_subscriptions")
        .select("id, bundle_id, status, synced_version, last_synced_at")
        .eq("user_id", user.id),
    ]);
    const nextBundles = (bundleRows as BundleRow[] | null) ?? [];
    const nextSubs = new Map(
      (((subRows as SubscriptionRow[] | null) ?? []).map((s) => [s.bundle_id, s])),
    );
    setBundles(nextBundles);
    setSubscriptions(nextSubs);
    setLoading(false);
    return { bundles: nextBundles, subs: nextSubs };
  }, [user, supabase]);

  /** Chunked apply loop; returns true when the sync fully completed. */
  const runApplyLoop = useCallback(
    async (bundle: BundleRow, opts: { silent: boolean }) => {
      let cursor: ApplyStep["nextCursor"] = null;
      let pinnedVersion: number | undefined;
      let claimToken: string | undefined;
      let applied = 0;
      if (!opts.silent) setProgress((p) => new Map(p).set(bundle.id, { applied: 0, total: bundle.prospect_count }));
      try {
        for (;;) {
          const outcome: { res: Response; step: ApplyStep & { error?: string }; retried: boolean } | null =
            await fetchStepWithRetry<ApplyStep>("/api/bundles/apply", {
              bundleId: bundle.id,
              cursor,
              pinnedVersion,
              claimToken,
            });
          if (!outcome) {
            // Subscribe also enqueued a delayed background job (CAR-47),
            // so this failure message is honest.
            throw new Error(BACKGROUND_SYNC_MESSAGE);
          }
          const res: Response = outcome.res;
          const step: ApplyStep & { error?: string } = outcome.step;
          const retried: boolean = outcome.retried;
          if (!res.ok) {
            if (res.status === 409) {
              // After a server error, the 409 is our own dead call's zombie
              // claim — surface the background handoff instead of silence.
              if (retried) throw new Error(BACKGROUND_SYNC_MESSAGE);
              // Otherwise another driver (worker/cron) is already syncing — fine.
              return false;
            }
            throw new Error(step.error ?? "Sync failed");
          }
          applied += step.applied;
          pinnedVersion = step.pinnedVersion;
          claimToken = step.claimToken ?? claimToken;
          if (!opts.silent) setProgress((p) => new Map(p).set(bundle.id, { applied, total: bundle.prospect_count }));
          if (step.done) return true;
          cursor = step.nextCursor;
        }
      } finally {
        setProgress((p) => {
          const next = new Map(p);
          next.delete(bundle.id);
          return next;
        });
      }
    },
    [],
  );

  const handleSubscribe = async (bundle: BundleRow) => {
    try {
      const res = await fetch("/api/bundles/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleId: bundle.id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Subscribe failed");
      setProgress((p) => new Map(p).set(bundle.id, { applied: 0, total: bundle.prospect_count }));
      await load();
      const completed = await runApplyLoop(bundle, { silent: false });
      if (completed) success(`Subscribed to ${bundle.name} — ${bundle.prospect_count} prospects added to your contacts`);
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Subscribe failed");
      await load();
    }
  };

  const handleUnsubscribe = async () => {
    const bundle = unsubscribeTarget;
    if (!bundle) return;
    setUnsubscribing(true);
    try {
      let cursor: number | null | undefined;
      let removed = 0;
      let kept = 0;
      for (;;) {
        const outcome = await fetchStepWithRetry<{
          done: boolean;
          nextCursor: number | null;
          removed: number;
          kept: number;
        }>("/api/bundles/unsubscribe", { bundleId: bundle.id, keepAll: unsubscribeChoice === "keep", cursor });
        if (!outcome) {
          // After the first successful step the server holds the cleanup
          // intent and the worker/cron finishes the removal (CAR-53). If not
          // even the first step landed, nothing changed server-side — the
          // background promise would be a lie, so ask for a retry instead.
          throw new Error(
            cursor !== undefined
              ? `Unsubscribed from ${bundle.name}, but the cleanup hit a server error — it will finish in the background.`
              : "Unsubscribe hit a server error before it could start — please try again.",
          );
        }
        const { res, step } = outcome;
        if (!res.ok) throw new Error(step.error ?? "Unsubscribe failed");
        removed += step.removed;
        kept += step.kept;
        if (step.done) break;
        cursor = step.nextCursor;
      }
      success(
        unsubscribeChoice === "keep"
          ? `Unsubscribed from ${bundle.name} — all contacts kept`
          : `Unsubscribed from ${bundle.name} — ${removed} removed, ${kept} kept`,
      );
      setUnsubscribeTarget(null);
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Unsubscribe failed");
    } finally {
      setUnsubscribing(false);
    }
  };

  // Initial load + opportunistic self-sync of stale subscriptions
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { bundles: loadedBundles, subs } = await load();
      if (selfSyncStarted.current) return;
      selfSyncStarted.current = true;
      for (const bundle of loadedBundles) {
        const sub = subs.get(bundle.id);
        if (sub?.status === "active" && sub.synced_version < bundle.version) {
          try {
            await runApplyLoop(bundle, { silent: true });
          } catch {
            toastError(`Background sync of ${bundle.name} failed — it will retry automatically`);
          }
        }
      }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) return null;

  return (
    <div className="space-y-7">
      <Card variant="outlined">
        <CardContent className="p-7">
          <div className="flex items-center gap-3 mb-2">
            <Database className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-medium text-foreground">Data subscriptions</h2>
          </div>
          <p className="text-base text-muted-foreground mb-6">
            Curated prospect lists and company databases. Subscribing adds the prospects to your
            contacts and keeps them updated automatically — your own edits are never overwritten.
          </p>

          {loading ? (
            <div className="flex items-center gap-4 text-muted-foreground">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
              <span className="text-base">Loading bundles...</span>
            </div>
          ) : bundles.length === 0 ? (
            <p className="text-base text-muted-foreground">
              No data bundles are available yet. Check back soon.
            </p>
          ) : (
            <div className="space-y-4">
              {bundles.map((bundle) => {
                const sub = subscriptions.get(bundle.id);
                const active = sub?.status === "active";
                const prog = progress.get(bundle.id);
                const syncing = prog != null || (active && sub!.synced_version < bundle.version);
                return (
                  <div key={bundle.id} className="p-5 rounded-xl border border-outline-variant">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-medium text-foreground">{bundle.name}</p>
                        {bundle.description && (
                          <p className="text-sm text-muted-foreground mt-1">{bundle.description}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Users className="h-3.5 w-3.5" />
                            {bundle.prospect_count} prospects
                          </span>
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3.5 w-3.5" />
                            {bundle.company_count} companies
                          </span>
                          {bundle.published_at && (
                            <span>Updated {new Date(bundle.published_at).toLocaleDateString()}</span>
                          )}
                        </div>
                        {active && (
                          <p className="flex items-center gap-1.5 mt-2 text-xs text-primary font-medium">
                            {prog ? (
                              <>
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                Importing {prog.applied}/{prog.total || "…"}
                              </>
                            ) : syncing ? (
                              <>
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                Syncing…
                              </>
                            ) : (
                              <>
                                <Check className="h-3.5 w-3.5" />
                                Subscribed
                                {sub?.last_synced_at &&
                                  ` · Last synced ${new Date(sub.last_synced_at).toLocaleString()}`}
                              </>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {active ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={prog != null || unsubscribing}
                            onClick={() => {
                              setUnsubscribeChoice("keep");
                              setUnsubscribeTarget(bundle);
                            }}
                          >
                            Unsubscribe
                          </Button>
                        ) : (
                          <Button size="sm" disabled={prog != null} onClick={() => handleSubscribe(bundle)}>
                            Subscribe
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Modal
        isOpen={unsubscribeTarget != null}
        onClose={() => !unsubscribing && setUnsubscribeTarget(null)}
        title={`Unsubscribe from ${unsubscribeTarget?.name ?? ""}`}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            What should happen to the contacts this bundle added?
          </p>
          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded-xl border border-outline-variant cursor-pointer">
              <input
                type="radio"
                name="unsubscribe-choice"
                className="mt-1"
                checked={unsubscribeChoice === "keep"}
                onChange={() => setUnsubscribeChoice("keep")}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">Keep all contacts</span>
                <span className="block text-xs text-muted-foreground">
                  They stay in your contacts; they just stop receiving bundle updates.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-xl border border-outline-variant cursor-pointer">
              <input
                type="radio"
                name="unsubscribe-choice"
                className="mt-1"
                checked={unsubscribeChoice === "remove"}
                onChange={() => setUnsubscribeChoice("remove")}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">Remove untouched contacts</span>
                <span className="block text-xs text-muted-foreground">
                  Contacts you&apos;ve edited, tagged, contacted, or moved out of Prospects are always kept.
                </span>
              </span>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="text" disabled={unsubscribing} onClick={() => setUnsubscribeTarget(null)}>
              Cancel
            </Button>
            <Button disabled={unsubscribing} onClick={handleUnsubscribe}>
              {unsubscribing ? "Unsubscribing…" : "Unsubscribe"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

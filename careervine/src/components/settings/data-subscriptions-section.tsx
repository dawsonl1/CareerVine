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
import { useAlumniAffinity } from "@/hooks/use-alumni-affinity";
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
  /** What a subscriber with no alumni affinity actually receives (CAR-213).
   * Read per bundle from bundle_alumni_stats; falls back to prospect_count,
   * which is exactly right for a BYU-family user. */
  eligible_prospect_count?: number;
}

interface SubscriptionRow {
  id: number;
  bundle_id: number;
  status: string;
  synced_version: number;
  last_synced_at: string | null;
}

// Apply-loop mechanics live in bundle-apply-client.ts, shared with the
// guided onboarding flow (CAR-50).
import {
  fetchStepWithRetry,
  subscribeToBundle,
  runBundleApplyLoop,
  type ApplyProgress,
} from "@/lib/bundle-apply-client";

export default function DataSubscriptionsSection() {
  const affinity = useAlumniAffinity();

  /**
   * What THIS subscriber receives from a bundle. Affinity users get all of it;
   * everyone else gets the bundle minus its alumni-only prospects, which is
   * roughly half. Falling back to the raw count means a failed stats read
   * overstates rather than showing zero, and the progress bar then completes
   * early instead of never — the safer of the two failure modes.
   */
  const eligibleCount = useCallback(
    (bundle: BundleRow) =>
      affinity.hasAffinity ? bundle.prospect_count : bundle.eligible_prospect_count ?? bundle.prospect_count,
    [affinity.hasAffinity],
  );

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
  // `disabled={prog != null}` cannot gate these: `prog` is set AFTER the first
  // await, so the button stayed live for the whole round trip and a double
  // click sent two POSTs. Both routes are non-idempotent — subscribe raced its
  // own UNIQUE constraint, and unsubscribe drives a destructive contact-removal
  // loop (CAR-207). Per-bundle for subscribe, since two different bundles may
  // legitimately be in flight at once; a single flag for unsubscribe, which is
  // driven by one modal.
  const subscribingRef = useRef(new Set<number>());
  const unsubscribingRef = useRef(false);

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
    let nextBundles = (bundleRows as BundleRow[] | null) ?? [];

    // CAR-213: the eligible count comes from bundle_alumni_stats, one call per
    // bundle. Skipped entirely for an affinity user, whose eligible count IS
    // prospect_count. Error-tolerated: every consumer falls back to
    // prospect_count, so a failed read overstates rather than showing nothing.
    if (!affinity.hasAffinity && nextBundles.length > 0) {
      const eligibles = await Promise.all(
        nextBundles.map(async (b) => {
          // try/catch, not just the { error } shape: a client without .rpc at
          // all (some test doubles) REJECTS rather than returning an error,
          // and an unhandled rejection here would take down the whole
          // subscriptions list rather than one optional count.
          try {
            const { data } = await supabase.rpc("bundle_alumni_stats", { p_bundle_id: b.id });
            const row = Array.isArray(data) ? data[0] : data;
            const n = Number(row?.eligible_prospect_count);
            return Number.isFinite(n) && n > 0 ? n : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      nextBundles = nextBundles.map((b, i) => ({ ...b, eligible_prospect_count: eligibles[i] }));
    }

    const nextSubs = new Map(
      (((subRows as SubscriptionRow[] | null) ?? []).map((s) => [s.bundle_id, s])),
    );
    setBundles(nextBundles);
    setSubscriptions(nextSubs);
    setLoading(false);
    return { bundles: nextBundles, subs: nextSubs };
  }, [user, supabase, affinity.hasAffinity]);

  /** Chunked apply loop; resolves completed: true when the sync finished. */
  const runApplyLoop = useCallback(
    async (bundle: BundleRow, opts: { silent: boolean }) => {
      try {
        return await runBundleApplyLoop(
          bundle,
          opts.silent
            ? undefined
            : (prog) => setProgress((p) => new Map(p).set(bundle.id, prog)),
        );
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
    if (subscribingRef.current.has(bundle.id)) return;
    subscribingRef.current.add(bundle.id);
    try {
      await subscribeToBundle(bundle.id);
      // CAR-213: what THIS subscriber receives, not what the bundle holds. A
      // non-affinity user gets 1,112 of 2,000, so the raw count both stalls
      // the bar below at 56% and toasts a number that is simply false at the
      // moment of the action.
      const eligible = eligibleCount(bundle);
      setProgress((p) => new Map(p).set(bundle.id, { applied: 0, total: eligible }));
      await load();
      const { completed } = await runApplyLoop(bundle, { silent: false });
      if (completed) success(`Subscribed to ${bundle.name}: ${eligible} prospects added to your contacts`);
      await load();
    } catch (err) {
      // The route's own message is the user-facing one here (the apply loop
      // throws copy like BACKGROUND_SYNC_MESSAGE that names the real outcome),
      // so this deliberately keeps its own catch rather than withToastOnError,
      // which discards it in favour of caller copy.
      toastError(err instanceof Error ? err.message : "Subscribe failed");
      await load();
    } finally {
      subscribingRef.current.delete(bundle.id);
    }
  };

  const handleUnsubscribe = async () => {
    const bundle = unsubscribeTarget;
    if (!bundle) return;
    if (unsubscribingRef.current) return;
    unsubscribingRef.current = true;
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
              ? `Unsubscribed from ${bundle.name}, but the cleanup hit a server error. It will finish in the background.`
              : "Unsubscribe hit a server error before it could start. Please try again.",
          );
        }
        if (!outcome.ok) throw new Error(outcome.error);
        const { step } = outcome;
        removed += step.removed;
        kept += step.kept;
        if (step.done) break;
        cursor = step.nextCursor;
      }
      success(
        unsubscribeChoice === "keep"
          ? `Unsubscribed from ${bundle.name}: all contacts kept`
          : `Unsubscribed from ${bundle.name}: ${removed} removed, ${kept} kept`,
      );
      setUnsubscribeTarget(null);
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Unsubscribe failed");
    } finally {
      unsubscribingRef.current = false;
      setUnsubscribing(false);
    }
  };

  // Initial load + opportunistic self-sync of stale subscriptions
  useEffect(() => {
    if (!user) return;
    // Fire-and-forget: load() resolves to empty data rather than rejecting, and
    // each background sync toasts its own failure below.
    void (async () => {
      const { bundles: loadedBundles, subs } = await load();
      if (selfSyncStarted.current) return;
      selfSyncStarted.current = true;
      for (const bundle of loadedBundles) {
        const sub = subs.get(bundle.id);
        if (sub?.status === "active" && sub.synced_version < bundle.version) {
          try {
            await runApplyLoop(bundle, { silent: true });
          } catch {
            toastError(`Background sync of ${bundle.name} failed. It will retry automatically`);
          }
        }
      }
      await load();
    })();
    // Once per user, by design. `load` and `runApplyLoop` are re-created per
    // render; depending on them would restart the background bundle sync on
    // every render, which is real network and Apify work, not a wasted fetch.
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
            contacts and keeps them updated automatically. Your own edits are never overwritten.
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
                            {eligibleCount(bundle)} prospects
                          </span>
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3.5 w-3.5" />
                            {bundle.company_count} companies
                          </span>
                          {bundle.published_at && (
                            <span>Updated {new Date(bundle.published_at).toLocaleDateString()}</span>
                          )}
                        </div>
                        {/* CAR-213. The one place the school's consequence is
                            visible is the number just above, so it is the
                            right place to say what shaped it and offer the
                            fix. Without this, a user who notices their counts
                            look wrong has no path from symptom to setting. */}
                        <p className="mt-2 text-xs text-muted-foreground">
                          {affinity.university
                            ? `Tailored for ${affinity.university}. `
                            : "Add your school to see alumni connections. "}
                          <a href="/settings?tab=account" className="text-primary hover:underline">
                            {affinity.university ? "Change" : "Add it"}
                          </a>
                        </p>
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

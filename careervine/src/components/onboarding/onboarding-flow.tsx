"use client";

/**
 * Guided-onboarding step UI (CAR-50). Authoritative flow: Dawson's FigJam
 * "Careervine Onboarding Flow". Modal sequence:
 *
 *   bundle offer (Yes emphasized / No → brief intro splash)
 *   → company picker, shown INSTANTLY from bundle-level stats (CAR-77) with
 *     the sync progress bar on top + Gmail/Calendar connect while it streams;
 *     Select stays gated until the sync completes
 *   → [outreach leg happens on the company page]
 *   → finale (confetti + "Grow your Career Vine")
 *
 * Every step has a quiet "skip for now" escape hatch; a closed tab resumes
 * from users.onboarding_state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import { track } from "@/lib/analytics/client";
import { useOnboarding } from "./onboarding-context";
import { ConfettiBurst } from "./confetti-burst";
import {
  getOnboardingBundleStats,
  type OnboardingBundleStats,
} from "@/lib/onboarding/bundle-stats";
import { getPickerCompanies, type PickerCompany } from "@/lib/onboarding/company-picker";
import {
  subscribeToBundle,
  runBundleApplyLoop,
  BACKGROUND_SYNC_MESSAGE,
  type ApplyProgress,
} from "@/lib/bundle-apply-client";
import { addTargetCompany } from "@/lib/company-queries";
import { Users, Building2, GraduationCap, Mail, Calendar, Check, Search, Sparkles } from "lucide-react";

/* ── Shared shell: full-screen scrim + centered card ── */
function StepShell({
  children,
  wide,
  onSkip,
}: {
  children: React.ReactNode;
  wide?: boolean;
  onSkip?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div
        className={`relative bg-surface-container-high rounded-[28px] shadow-2xl w-full ${
          wide ? "max-w-2xl" : "max-w-lg"
        } max-h-[90vh] overflow-y-auto p-8`}
      >
        {children}
        {onSkip && (
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Skip for now, I&apos;ll explore on my own
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Step 1: bundle offer ── */
function BundleOfferStep({
  stats,
  onAccept,
  onDecline,
  onSkip,
}: {
  stats: OnboardingBundleStats | null;
  onAccept: () => void;
  onDecline: () => void;
  onSkip: () => void;
}) {
  return (
    <StepShell onSkip={onSkip}>
      <div className="text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-5">
          <GraduationCap className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-foreground">
          Start with a network, not an empty page
        </h2>
        <p className="text-base text-muted-foreground mt-3 leading-relaxed">
          Get our curated <span className="font-medium text-foreground">{stats?.name ?? "APM recruiting"}</span> database:{" "}
          {stats && stats.alumniCount > 0 ? (
            <>
              <span className="font-medium text-foreground">
                {stats.alumniCount.toLocaleString()} BYU alumni
              </span>{" "}
              among{" "}
              <span className="font-medium text-foreground">
                {stats.prospectCount.toLocaleString()} prospects
              </span>{" "}
              at companies that hire new-grad PMs.
            </>
          ) : (
            <>real PMs, recruiters, and alumni at companies that hire new-grad PMs.</>
          )}
        </p>
        <div className="mt-7 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onAccept}
            className="h-12 rounded-full bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 transition-colors cursor-pointer shadow-md"
          >
            Yes, add it to my account
          </button>
          <button
            type="button"
            onClick={onDecline}
            className="h-10 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-surface-container transition-colors cursor-pointer"
          >
            No thanks
          </button>
        </div>
      </div>
    </StepShell>
  );
}

/* ── No-path: brief intro splash ── */
function IntroSplashStep({ onDone }: { onDone: () => void }) {
  return (
    <StepShell>
      <h2 className="text-xl font-semibold text-foreground">Welcome to CareerVine</h2>
      <p className="text-sm text-muted-foreground mt-2">
        Your personal CRM for networking. Three fast ways to get value:
      </p>
      <ul className="mt-5 space-y-4">
        <li className="flex gap-3">
          <Users className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Add a contact you know</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Log one real conversation and CareerVine starts tracking the follow-up for you.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <Building2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Target a company</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Track applications, contacts, and outreach for the companies you actually want.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <Mail className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Connect Gmail</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Send outreach, schedule sends, and auto-cancel follow-ups when people reply.
            </p>
          </div>
        </li>
      </ul>
      <button
        type="button"
        onClick={onDone}
        className="mt-7 w-full h-11 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors cursor-pointer"
      >
        Get started
      </button>
    </StepShell>
  );
}

function ConnectButton({
  connected,
  icon: Icon,
  label,
  connectedLabel,
  href,
}: {
  connected: boolean;
  icon: typeof Mail;
  label: string;
  connectedLabel: string;
  href: string;
}) {
  if (connected) {
    return (
      <span className="flex w-full items-center justify-center gap-2 h-11 px-4 rounded-full bg-primary/10 text-primary text-sm font-medium">
        <Check className="h-4 w-4" />
        {connectedLabel}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="flex w-full items-center justify-center gap-2 h-11 px-4 rounded-full border border-outline text-sm font-medium text-foreground hover:bg-surface-container-high transition-colors"
    >
      <Icon className="h-4 w-4" />
      {label}
    </a>
  );
}

/* ── Connect step (CAR-82): a deliberate stop to connect Gmail + Calendar
 * before the company picker. Onboarding ends by sending a real email (needs
 * Gmail), so this replaces the connect prompt that used to live in the sync
 * header and vanish the moment the import finished — leaving users past it,
 * unconnected. Skippable, but a step the user passes through on purpose. */
function ConnectStep({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  const { data: gmailConn, calendarConnected, refresh: refreshConnection } = useGmailConnection();
  const gmailConnected = gmailConn !== null;

  // Flip the buttons to "connected" once the OAuth round-trip finishes in its
  // own tab (returnTo=/onboarding/connected).
  useEffect(() => {
    const t = setInterval(() => refreshConnection(), 3000);
    return () => clearInterval(t);
  }, [refreshConnection]);

  return (
    <StepShell onSkip={onSkip}>
      <div className="text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-5">
          <Mail className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-foreground">Connect Gmail and Calendar</h2>
        <p className="text-base text-muted-foreground mt-3 leading-relaxed">
          You&apos;ll finish setup by sending your first networking email. Connect Gmail to send it
          and auto-cancel follow-ups when people reply, and Calendar to drop your open times into any
          message in one click.
        </p>
      </div>

      <div className="mt-7 flex flex-col gap-2.5">
        <ConnectButton
          connected={gmailConnected}
          icon={Mail}
          label="Connect Gmail"
          connectedLabel="Gmail connected"
          href="/api/gmail/auth?returnTo=%2Fonboarding%2Fconnected"
        />
        <ConnectButton
          connected={calendarConnected}
          icon={Calendar}
          label="Connect Google Calendar"
          connectedLabel="Calendar connected"
          href="/api/gmail/auth?scopes=calendar&returnTo=%2Fonboarding%2Fconnected"
        />
        <button
          type="button"
          onClick={onContinue}
          className="mt-4 h-12 rounded-full bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 transition-colors cursor-pointer shadow-md"
        >
          {gmailConnected ? "Continue" : "Continue without connecting"}
        </button>
      </div>
    </StepShell>
  );
}

/* ── Steps 2+3 merged (CAR-77): instant company picker with sync on top ──
 *
 * The list renders from bundle-level stats (bundle_company_stats RPC,
 * subscriber-scoped) the moment the subscription exists — no waiting on the
 * contact copy. While the sync streams, a progress header sits on top and
 * Select is disabled; completion advances the flow state, which re-renders
 * this same mounted component with syncing=false and unlocks Select.
 */
function CompanyPickerStep({
  stats,
  syncing,
  onSyncComplete,
  onPicked,
  onSkip,
}: {
  stats: OnboardingBundleStats;
  syncing: boolean;
  onSyncComplete: () => void;
  onPicked: (company: PickerCompany) => void;
  onSkip: () => void;
}) {
  const [companies, setCompanies] = useState<PickerCompany[] | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState<number | null>(null);
  const [loopProgress, setLoopProgress] = useState<ApplyProgress | null>(null);
  const [dbApplied, setDbApplied] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);
  const doneRef = useRef(false);
  const startedAtRef = useRef(0);
  const companiesRequested = useRef(false);
  // Resumed pick_company sessions are already subscribed; a fresh accept
  // must wait for the subscribe call before the RPC can see bundle rows.
  const [subscribed, setSubscribed] = useState(!syncing);

  // path is absent when a background driver finished the sync and this tab
  // never saw an apply response (CAR-78 instrumentation).
  const finish = useCallback(
    (path?: "fast" | "merge") => {
      if (doneRef.current) return;
      doneRef.current = true;
      track("onboarding_sync_completed", {
        prospects: stats.prospectCount,
        path,
        duration_ms: startedAtRef.current ? Date.now() - startedAtRef.current : undefined,
      });
      onSyncComplete();
    },
    [onSyncComplete, stats.prospectCount],
  );

  // Drive the sync (subscribe + apply loop) exactly once.
  useEffect(() => {
    if (!syncing || started.current) return;
    started.current = true;
    startedAtRef.current = Date.now();
    (async () => {
      try {
        // Resume-safe: subscribing when already subscribed is handled
        // server-side; the apply loop picks up wherever the sync left off.
        await subscribeToBundle(stats.bundleId).catch(() => {});
        setSubscribed(true);
        const { completed, path } = await runBundleApplyLoop(
          { id: stats.bundleId, prospect_count: stats.prospectCount },
          setLoopProgress,
        );
        if (completed) finish(path);
        // Not completed → another driver (worker/cron) owns the sync; the
        // durable-signal poll below detects it finishing.
      } catch (err) {
        // Background job will finish the work; the poll owns completion.
        setNotice(err instanceof Error ? err.message : BACKGROUND_SYNC_MESSAGE);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  // Unmount (skip, navigation) must suppress a stale finish() and stop polls.
  useEffect(
    () => () => {
      doneRef.current = true;
    },
    [],
  );

  // Progress + durable completion poll (CAR-77): counting the subscription's
  // linkage rows keeps the bar moving no matter which driver runs the sync
  // (client loop, QStash worker, cron), and synced_version >= version is the
  // same completion signal the old sync modal polled.
  useEffect(() => {
    if (!syncing) return;
    const supabase = createSupabaseBrowserClient();
    let subscriptionId: number | null = null;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || doneRef.current) return;
      if (subscriptionId === null) {
        const { data: sub } = await supabase
          .from("bundle_subscriptions")
          .select("id")
          .eq("bundle_id", stats.bundleId)
          .maybeSingle();
        subscriptionId = (sub as { id: number } | null)?.id ?? null;
        if (subscriptionId === null) return; // subscribe hasn't landed yet
      }
      const [{ count }, { data: subRow }, { data: bundle }] = await Promise.all([
        supabase
          .from("bundle_subscription_contacts")
          .select("id", { count: "exact", head: true })
          .eq("subscription_id", subscriptionId),
        supabase
          .from("bundle_subscriptions")
          .select("synced_version, status")
          .eq("id", subscriptionId)
          .maybeSingle(),
        supabase.from("data_bundles").select("version").eq("id", stats.bundleId).maybeSingle(),
      ]);
      if (cancelled || doneRef.current) return;
      if (typeof count === "number") setDbApplied(count);
      const s = subRow as { synced_version: number; status: string } | null;
      const v = (bundle as { version: number } | null)?.version;
      if (s?.status === "active" && v != null && s.synced_version >= v) finish();
    };
    const t = setInterval(tick, 2500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [syncing, stats.bundleId, finish]);

  // Company list from bundle-level stats — available as soon as subscribed.
  useEffect(() => {
    if (!subscribed || companiesRequested.current) return;
    companiesRequested.current = true;
    getPickerCompanies(stats.bundleId).then(setCompanies).catch(() => setCompanies([]));
  }, [subscribed, stats.bundleId]);

  const filtered = useMemo(() => {
    if (!companies) return null;
    const q = query.trim().toLowerCase();
    return q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies;
  }, [companies, query]);

  // Best signal wins: the DB count survives page reloads and background
  // drivers; the loop's applied total updates between polls.
  const applied = Math.max(loopProgress?.applied ?? 0, dbApplied);
  const total = stats.prospectCount;
  const pct = total > 0 ? Math.min(100, Math.round((applied / total) * 100)) : null;

  return (
    <StepShell wide onSkip={onSkip}>
      <h2 className="text-xl font-semibold text-foreground">Pick your first target company</h2>
      <p className="text-sm text-muted-foreground mt-1.5">
        Companies with BYU alumni are at the top: alumni are the warmest door in. You can add
        more targets anytime.
      </p>

      {syncing && (
        <div className="mt-4 p-4 rounded-2xl bg-surface-container border border-outline-variant/40">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-foreground">Building your network…</p>
            <p className="text-xs text-muted-foreground shrink-0">
              {applied > 0 ? `${applied.toLocaleString()} of ${total.toLocaleString()} added` : "Starting sync…"}
            </p>
          </div>
          <div className="mt-2 w-full h-2 bg-surface-container-highest rounded-full overflow-hidden">
            {applied === 0 ? (
              <div className="h-full w-1/3 bg-primary rounded-full animate-pulse" />
            ) : (
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{ width: `${Math.max(pct ?? 0, 3)}%` }}
              />
            )}
          </div>
          {notice && <p className="text-xs text-muted-foreground mt-2">{notice}</p>}
          <p className="mt-3 text-xs text-muted-foreground">
            Browse the list now, then pick your first target the moment your import finishes.
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 h-10 px-3.5 rounded-full border border-outline-variant bg-surface-container-low">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search companies…"
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      <div className="mt-4 max-h-[46vh] overflow-y-auto space-y-1.5 pr-1">
        {filtered === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading companies…</p>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No companies match.</p>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className="group flex items-center gap-3 p-3 rounded-xl border border-outline-variant/40 hover:border-primary/40 hover:bg-surface-container transition-colors"
            >
              {c.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.logoUrl} alt="" className="w-9 h-9 rounded-lg object-contain bg-white shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-lg bg-surface-container-highest flex items-center justify-center shrink-0">
                  <Building2 className="h-4.5 w-4.5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                <p className="text-xs text-muted-foreground">
                  {c.contactCount} contact{c.contactCount === 1 ? "" : "s"}
                </p>
              </div>
              {c.alumniCount > 0 && (
                // Two stacked counts (CAR-61): total alumni, then how many of
                // them hold product roles.
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                    <GraduationCap className="h-3.5 w-3.5" />
                    {c.alumniCount} BYU {c.alumniCount === 1 ? "alum" : "alumni"}
                  </span>
                  {c.productAlumniCount > 0 && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-surface-container-highest text-muted-foreground text-[11px] font-medium">
                      {c.productAlumniCount} in product {c.productAlumniCount === 1 ? "role" : "roles"}
                    </span>
                  )}
                </div>
              )}
              <button
                type="button"
                disabled={syncing || selecting !== null}
                title={syncing ? "Your import is still finishing — Select unlocks the moment it's done." : undefined}
                onClick={async () => {
                  setSelecting(c.id);
                  onPicked(c);
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {syncing ? "Importing…" : selecting === c.id ? "Selecting…" : "Select"}
              </button>
            </div>
          ))
        )}
      </div>
    </StepShell>
  );
}

/* ── Finale: confetti + what's next ── */
function FinaleStep({ onDone }: { onDone: () => void }) {
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowMore(true), 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <StepShell wide>
      <ConfettiBurst className="rounded-[28px]" />

      <div className="text-center">
        <h2 className="text-2xl font-semibold text-foreground">
          🎉 Your first networking email is on its way
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          Follow-ups are scheduled and will cancel themselves the moment they reply.
        </p>
      </div>

      <div
        className={`mt-7 transition-opacity duration-700 ${showMore ? "opacity-100" : "opacity-0"}`}
      >
        <p className="text-sm font-medium text-foreground">
          There&apos;s a lot more CareerVine can do for your networking, during the job hunt and
          after:
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Sparkles className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Chrome extension</span>: add anyone
              from LinkedIn to your network in one click.
            </span>
          </li>
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Users className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Personalized suggestions</span>: who
              to reach out to next, and when, based on your real activity.
            </span>
          </li>
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Calendar className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Availability in one click</span>:
              drop your calendar&apos;s open slots straight into any email.
            </span>
          </li>
        </ul>
        <button
          type="button"
          onClick={onDone}
          className="mt-7 w-full h-12 rounded-full bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 transition-colors cursor-pointer shadow-md"
        >
          Grow your Career Vine
        </button>
      </div>
    </StepShell>
  );
}

/* ── Orchestrator ── */
export function OnboardingFlow() {
  const { user } = useAuth();
  const { state, showFinale, advance, skip, finishFinale } = useOnboarding();
  const router = useRouter();
  const pathname = usePathname();
  const [stats, setStats] = useState<OnboardingBundleStats | null>(null);
  const [statsResolved, setStatsResolved] = useState(false);
  const [declinedSplash, setDeclinedSplash] = useState(false);
  const statsLoaded = useRef(false);

  const active =
    state === "not_started" ||
    state === "connect" ||
    state === "syncing" ||
    state === "pick_company";

  useEffect(() => {
    if (!active || statsLoaded.current) return;
    statsLoaded.current = true;
    getOnboardingBundleStats()
      .then(setStats)
      .finally(() => setStatsResolved(true));
  }, [active]);

  // The OAuth-return tab lands on /onboarding/connected (connects are launched
  // from the connect step, and the picker still runs the sync) — without this
  // guard an onboarding modal would remount there, cover the "Connected!"
  // message, and could start a duplicate apply loop.
  if (pathname === "/onboarding/connected") return null;

  if (!user || state === null) return null;

  if (showFinale) return <FinaleStep onDone={finishFinale} />;

  if (declinedSplash) {
    return <IntroSplashStep onDone={() => setDeclinedSplash(false)} />;
  }

  // No published bundle — fall back to the brief intro. pick_company is
  // included since CAR-77: the picker reads bundle-level stats, so without a
  // bundle there is nothing to pick from.
  if (statsResolved && !stats && active) {
    return <IntroSplashStep onDone={() => advance("completed")} />;
  }

  if (state === "not_started") {
    return (
      <BundleOfferStep
        stats={stats}
        onAccept={() => {
          if (!stats) return; // still resolving — button is effectively inert
          track("onboarding_bundle_accepted", {});
          advance("connect");
        }}
        onDecline={() => {
          track("onboarding_bundle_declined", {});
          // Persist immediately so a refresh mid-splash doesn't re-offer the
          // bundle; the splash itself is purely cosmetic local state.
          advance("completed");
          setDeclinedSplash(true);
        }}
        onSkip={() => skip("bundle_offer")}
      />
    );
  }

  if (state === "connect") {
    return (
      <ConnectStep
        onContinue={() => {
          track("onboarding_connect_advanced", {});
          advance("syncing");
        }}
        onSkip={() => skip("connect")}
      />
    );
  }

  if (state === "syncing" || state === "pick_company") {
    // Stats still loading on a resumed session — hold the scrim without content.
    if (!stats) return null;
    return (
      <CompanyPickerStep
        stats={stats}
        syncing={state === "syncing"}
        onSyncComplete={() => advance("pick_company")}
        onPicked={async (company) => {
          try {
            await addTargetCompany(user.id, company.id);
          } catch {
            // Company may already be a target (e.g. resumed flow) — proceed.
          }
          track("onboarding_company_picked", { alumni_count: company.alumniCount });
          advance("outreach");
          router.push(`/companies/${company.id}`);
        }}
        onSkip={() => skip(state)}
      />
    );
  }

  return null;
}

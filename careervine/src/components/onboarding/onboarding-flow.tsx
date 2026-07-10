"use client";

/**
 * Guided-onboarding step UI (CAR-50). Authoritative flow: Dawson's FigJam
 * "Careervine Onboarding Flow". Modal sequence:
 *
 *   bundle offer (Yes emphasized / No → brief intro splash)
 *   → progress modal (live stats + progress bar + Gmail/Calendar connect)
 *   → company picker (ranked by BYU-alumni count)
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
              Skip for now — I&apos;ll explore on my own
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
          Get our curated <span className="font-medium text-foreground">{stats?.name ?? "APM recruiting"}</span> database —{" "}
          {stats && stats.alumniCount > 0 ? (
            <>
              <span className="font-medium text-foreground">
                {stats.alumniCount.toLocaleString()} BYU alumni
              </span>{" "}
              in product roles among{" "}
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
            Yes — add it to my account
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

/* ── Step 2: background sync + progress + connect-while-you-wait ── */
function SyncProgressStep({
  stats,
  onComplete,
  onSkip,
}: {
  stats: OnboardingBundleStats;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data: gmailConn, calendarConnected, refresh: refreshConnection } = useGmailConnection();
  const gmailConnected = gmailConn !== null;
  const started = useRef(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    track("onboarding_sync_completed", { prospects: stats.prospectCount });
    onComplete();
  }, [onComplete, stats.prospectCount]);

  // Poll the durable completion signal — covers the cases where another
  // driver (background worker/cron) owns the sync or our loop errored over
  // to the background job.
  const pollUntilSynced = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      if (doneRef.current) return;
      const [{ data: sub }, { data: bundle }] = await Promise.all([
        supabase
          .from("bundle_subscriptions")
          .select("synced_version, status")
          .eq("bundle_id", stats.bundleId)
          .maybeSingle(),
        supabase.from("data_bundles").select("version").eq("id", stats.bundleId).maybeSingle(),
      ]);
      if (sub?.status === "active" && bundle && sub.synced_version >= bundle.version) {
        finish();
        return;
      }
    }
  }, [stats.bundleId, finish]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        // Resume-safe: subscribing when already subscribed is handled
        // server-side; the apply loop picks up wherever the sync left off.
        await subscribeToBundle(stats.bundleId).catch(() => {});
        const completed = await runBundleApplyLoop(
          { id: stats.bundleId, prospect_count: stats.prospectCount },
          setProgress,
        );
        if (completed) finish();
        else await pollUntilSynced(); // another driver owns it
      } catch (err) {
        setNotice(err instanceof Error ? err.message : BACKGROUND_SYNC_MESSAGE);
        await pollUntilSynced();
      }
    })();
    // Unmount (skip, advance, navigation) must stop the poll loop and
    // suppress a stale finish() — doneRef is the loop's exit signal.
    return () => {
      doneRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Light poll so the buttons flip to "connected" after the OAuth
  // round-trip completes in its own tab.
  useEffect(() => {
    const t = setInterval(() => refreshConnection(), 5000);
    return () => clearInterval(t);
  }, [refreshConnection]);

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.applied / progress.total) * 100)) : null;

  return (
    <StepShell wide onSkip={onSkip}>
      <h2 className="text-xl font-semibold text-foreground">Building your network…</h2>
      <p className="text-sm text-muted-foreground mt-1.5">We&apos;re adding:</p>
      <ul className="mt-4 space-y-2.5">
        <StatLine icon={Users} text={`${stats.prospectCount.toLocaleString()} prospects with contact information`} />
        <StatLine icon={GraduationCap} text={`${stats.alumniCount.toLocaleString()} BYU alumni in product roles`} />
        <StatLine icon={Building2} text={`${stats.companyCount.toLocaleString()} companies with a history of hiring new-grad PMs`} />
        {stats.alumniCompanyCount > 0 && (
          // Alumni were sourced beyond the target-company list, so this count
          // (~1,079) exceeds companyCount (99) — never phrase it as a subset.
          <StatLine icon={Check} text={`${stats.alumniCompanyCount.toLocaleString()} companies where those alumni work today`} />
        )}
      </ul>

      <div className="mt-6">
        <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden">
          {pct === null ? (
            <div className="h-full w-1/3 bg-primary rounded-full animate-pulse" />
          ) : (
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${Math.max(pct, 3)}%` }}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {notice ??
            (progress
              ? `${progress.applied.toLocaleString()} of ${progress.total.toLocaleString()} added`
              : "Starting sync…")}
        </p>
      </div>

      <div className="mt-7 p-5 rounded-2xl bg-surface-container border border-outline-variant/40">
        <p className="text-sm font-medium text-foreground">While you wait…</p>
        <p className="text-xs text-muted-foreground mt-1">
          Connect Gmail and Google Calendar so you&apos;re ready to send your first personalized
          networking request to one of your new prospects.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
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
            label="Connect Calendar"
            connectedLabel="Calendar connected"
            href="/api/gmail/auth?scopes=calendar&returnTo=%2Fonboarding%2Fconnected"
          />
        </div>
      </div>
    </StepShell>
  );
}

function StatLine({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm text-foreground">
      <Icon className="h-4 w-4 text-primary shrink-0" />
      {text}
    </li>
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
      <span className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-primary/10 text-primary text-sm font-medium">
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
      className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-outline text-sm font-medium text-foreground hover:bg-surface-container-high transition-colors"
    >
      <Icon className="h-4 w-4" />
      {label}
    </a>
  );
}

/* ── Step 3: pick a target company ── */
function CompanyPickerStep({
  onPicked,
  onSkip,
}: {
  onPicked: (company: PickerCompany) => void;
  onSkip: () => void;
}) {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<PickerCompany[] | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    getPickerCompanies(user.id).then(setCompanies).catch(() => setCompanies([]));
  }, [user]);

  const filtered = useMemo(() => {
    if (!companies) return null;
    const q = query.trim().toLowerCase();
    return q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies;
  }, [companies, query]);

  return (
    <StepShell wide onSkip={onSkip}>
      <h2 className="text-xl font-semibold text-foreground">Pick your first target company</h2>
      <p className="text-sm text-muted-foreground mt-1.5">
        Companies with BYU alumni are at the top — alumni are the warmest door in. You can add
        more targets anytime.
      </p>

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
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium shrink-0">
                  <GraduationCap className="h-3.5 w-3.5" />
                  {c.alumniCount} BYU {c.alumniCount === 1 ? "alum" : "alumni"}
                </span>
              )}
              <button
                type="button"
                disabled={selecting !== null}
                onClick={async () => {
                  setSelecting(c.id);
                  onPicked(c);
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all cursor-pointer shrink-0 disabled:opacity-40"
              >
                {selecting === c.id ? "Selecting…" : "Select"}
              </button>
            </div>
          ))
        )}
      </div>
    </StepShell>
  );
}

/* ── Finale: confetti + what's next ── */
const CONFETTI_COLORS = ["#4f6f52", "#e8a13c", "#7ca5b8", "#c96f4a", "#8f5aa5"];

function FinaleStep({ onDone }: { onDone: () => void }) {
  const [showMore, setShowMore] = useState(false);
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        duration: 2.2 + Math.random() * 1.6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        rotate: Math.random() * 360,
      })),
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => setShowMore(true), 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <StepShell wide>
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[28px]">
        {pieces.map((p, i) => (
          <span
            key={i}
            className="absolute top-[-12px] w-2 h-3 rounded-[2px]"
            style={{
              left: `${p.left}%`,
              backgroundColor: p.color,
              transform: `rotate(${p.rotate}deg)`,
              animation: `cv-confetti-fall ${p.duration}s ease-in ${p.delay}s forwards`,
            }}
          />
        ))}
        <style>{`
          @keyframes cv-confetti-fall {
            0% { transform: translateY(0) rotate(0deg); opacity: 1; }
            100% { transform: translateY(85vh) rotate(540deg); opacity: 0; }
          }
        `}</style>
      </div>

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
          There&apos;s a lot more CareerVine can do for your networking — during the job hunt and
          after:
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Sparkles className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Chrome extension</span> — add anyone
              from LinkedIn to your network in one click.
            </span>
          </li>
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Users className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Personalized suggestions</span> — who
              to reach out to next, and when, based on your real activity.
            </span>
          </li>
          <li className="flex gap-3 text-sm text-muted-foreground">
            <Calendar className="h-4.5 w-4.5 text-primary shrink-0 mt-0.5" />
            <span>
              <span className="font-medium text-foreground">Availability in one click</span> —
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

  const active = state === "not_started" || state === "syncing" || state === "pick_company";

  useEffect(() => {
    if (!active || statsLoaded.current) return;
    statsLoaded.current = true;
    getOnboardingBundleStats()
      .then(setStats)
      .finally(() => setStatsResolved(true));
  }, [active]);

  // The OAuth-return tab lands on /onboarding/connected while state is
  // 'syncing' — without this guard the full sync modal would remount there,
  // cover the "Connected!" message, and start a duplicate apply loop.
  if (pathname === "/onboarding/connected") return null;

  if (!user || state === null) return null;

  if (showFinale) return <FinaleStep onDone={finishFinale} />;

  if (declinedSplash) {
    return <IntroSplashStep onDone={() => setDeclinedSplash(false)} />;
  }

  // No published bundle to offer — fall back to the brief intro.
  if (statsResolved && !stats && (state === "not_started" || state === "syncing")) {
    return <IntroSplashStep onDone={() => advance("completed")} />;
  }

  if (state === "not_started") {
    return (
      <BundleOfferStep
        stats={stats}
        onAccept={() => {
          if (!stats) return; // still resolving — button is effectively inert
          track("onboarding_bundle_accepted", {});
          advance("syncing");
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

  if (state === "syncing") {
    // Stats still loading on a resumed session — hold the scrim without content.
    if (!stats) return null;
    return (
      <SyncProgressStep
        stats={stats}
        onComplete={() => advance("pick_company")}
        onSkip={() => skip("syncing")}
      />
    );
  }

  if (state === "pick_company") {
    return (
      <CompanyPickerStep
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
        onSkip={() => skip("pick_company")}
      />
    );
  }

  return null;
}

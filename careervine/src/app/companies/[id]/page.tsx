"use client";

import { useCallback, useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { useCompose } from "@/components/compose-email-context";
import { PipelineLayout } from "@/components/companies/pipeline/pipeline-layout";
import { usePipelineAutosave } from "@/hooks/use-pipeline-autosave";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useCachedList } from "@/hooks/use-cached-list";
import { fetchCompanyScopes } from "@/lib/company-scopes";
import { loadPipeline, type LoadedPipeline } from "@/lib/pipeline-queries";
import { COMPANY_SCOPES_TTL_MS, companyScopesKey } from "@/lib/company-detail-cache";
import {
  demoteContactToBench,
  promoteContactToProspect,
  type CompanyPerson,
} from "@/lib/company-queries";
import { activateContact, getFreshJobChangeContactIds } from "@/lib/queries";
import { invalidateCompaniesList } from "@/lib/companies-list-cache";
import { invalidateCompanyScopes } from "@/lib/company-detail-cache";
import { hasInAppBackHistory } from "@/lib/nav-history";
import type { ContactTier } from "@/components/companies/pipeline/pipeline-layout";
import { useOnboarding } from "@/components/onboarding/onboarding-context";
import {
  renderOnboardingIntro,
  renderOnboardingFollowUps,
} from "@/lib/onboarding/templates";
import { ArrowLeft, Mail } from "lucide-react";
import { useAlumniAffinity } from "@/hooks/use-alumni-affinity";

/**
 * Company recruiting page (CAR-6): full contact roster on the left, the
 * per-scope recruiting pipeline on the right. Scope (company-wide vs a
 * specific office) lives in the ?location= query param.
 */
export default function CompanyPipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const companyId = Number(id);
  const { user } = useAuth();
  const affinity = useAlumniAffinity();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError, success: toastSuccess } = useToast();
  const { openCompose, gmailConnected } = useCompose();
  const { state: onboardingState } = useOnboarding();
  const onboardingOutreach = onboardingState === "outreach";

  // Bench contacts with an unactioned job-change event (plan 29 Q5 hint)
  const [jobChangeIds, setJobChangeIds] = useState<Set<number>>(new Set());

  // ── The roster: cached, so returning from a contact is instant (CAR-268) ──
  //
  // Only this half is cached. It is the expensive read (getContactStages fans
  // out to eight legs) and the page never mutates it. The pipeline below is
  // deliberately NOT cached — see `company-detail-cache.ts` for why restoring
  // autosave-backed state from a snapshot loses edits.
  const cacheKey =
    user && !Number.isNaN(companyId) ? companyScopesKey(user.id, companyId) : null;

  const {
    data: scopes,
    loading: scopesLoading,
    failed: scopesFailed,
    reload: reloadScopes,
  } = useCachedList<Awaited<ReturnType<typeof fetchCompanyScopes>> | null>({
    key: cacheKey,
    // Inline rather than a memoized callback: `useCachedList` keeps the fetcher
    // in a ref, so an unstable reference cannot loop, and everything this reads
    // is already encoded in `key`.
    fetcher: async () =>
      user && !Number.isNaN(companyId) ? fetchCompanyScopes(user.id, companyId) : null,
    ttlMs: COMPANY_SCOPES_TTL_MS,
    fallback: null,
  });

  const company = scopes?.company ?? null;
  const tabs = scopes?.tabs ?? null;
  const offices = scopes?.offices ?? [];
  const totalContacts = scopes?.totalContacts ?? 0;
  const target = scopes?.target ?? null;
  // A failed scopes read is what "no such company" looked like before the
  // split, and it still is: the two throws were never distinguished.
  const notFound = scopesFailed;

  // ── The pipeline: always refetched, never cached ──────────────────────────
  //
  // `usePipelineAutosave` seeds a reducer from this and writes back on a
  // debounce, so a cached copy is a copy that predates the user's own unflushed
  // edits. Refetching it is cheap (one company's rows across six small tables)
  // and it no longer gates the roster, which is what makes that affordable.
  const [loaded, setLoaded] = useState<LoadedPipeline | null>(null);
  const [pipelineFailed, setPipelineFailed] = useState(false);
  // Two of these can overlap: a tier move reloads while the first is in flight.
  const pipelineRequest = useLatestRequest();

  const loadPipelineState = useCallback(() => {
    if (!user || Number.isNaN(companyId)) return;
    const token = pipelineRequest.begin();
    // The failure flag is cleared on SUCCESS rather than up front: a
    // synchronous setState in the effect body cascades a render, and
    // `react-hooks/set-state-in-effect` rejects it.
    loadPipeline(user.id, companyId)
      .then((p) => {
        if (!pipelineRequest.isLatest(token)) return;
        setLoaded(p);
        setPipelineFailed(false);
      })
      .catch((e) => {
        if (!pipelineRequest.isLatest(token)) return;
        console.error("Error loading pipeline:", e);
        // `loaded` is left alone, matching the roster's no-clear rule: a failed
        // refresh keeps a pipeline that is still valid on screen.
        setPipelineFailed(true);
      });
  }, [user, companyId, pipelineRequest]);

  useEffect(() => {
    loadPipelineState();
  }, [loadPipelineState]);

  /** Re-read both halves after a write this page performed. */
  const load = useCallback(async () => {
    // `reload` bypasses the cache AND rewrites it, so the entry cannot serve
    // the state the write just contradicted.
    reloadScopes();
    loadPipelineState();
  }, [reloadScopes, loadPipelineState]);

  // Best-effort job-change hint — never blocks the page, so it stays outside
  // the cached payload and re-runs on a cache hit. One small read against a
  // roster that is already on screen.
  const benchKey = tabs ? tabs.all.bench.map((p) => p.contact_id).join(",") : "";
  useEffect(() => {
    if (!benchKey) return;
    let live = true;
    getFreshJobChangeContactIds(benchKey.split(",").map(Number))
      .then((ids) => {
        if (live) setJobChangeIds(ids);
      })
      // error-tolerated: a hint badge nobody asked for; nothing on screen
      // depends on it and the roster is already rendered.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [benchKey]);

  const { state, saveStatus, actions } = usePipelineAutosave({
    userId: user?.id ?? null,
    companyId,
    tabs,
    target,
    loaded,
  });

  // Scope lives in the URL so office views are shareable/bookmarkable.
  const scopeParam = searchParams.get("location") ?? "all";
  const scope =
    scopeParam === "all" || tabs?.offices.some((o) => o.key === scopeParam) ? scopeParam : "all";

  const setScope = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "all") params.delete("location");
    else params.set("location", key);
    router.replace(`/companies/${companyId}${params.size ? `?${params}` : ""}`);
  };

  // Onboarding outreach leg (CAR-50): the guided flow lands here after the
  // user picks a target company. Compose opens pre-filled from the static
  // template — alumni variant when the prospect went to the user's own school.
  const composeForOnboarding = useCallback(
    (opts?: Parameters<typeof openCompose>[0]) => {
      if (!onboardingOutreach || !opts?.contactId || !tabs || !company) {
        openCompose(opts);
        return;
      }
      const person = [...tabs.all.current, ...tabs.all.former, ...tabs.all.bench].find(
        (p) => p.contact_id === opts.contactId,
      );
      const merge = {
        contactFirstName: (opts.name || person?.name || "").split(/\s+/)[0] || null,
        companyName: company.name,
        senderFirstName: (user?.user_metadata?.first_name as string | undefined) ?? null,
        // CAR-213: the alumni variant names the SENDER's school. Null forces
        // the neutral variant, which claims no connection at all.
        senderSchool: affinity.university,
      };
      const intro = renderOnboardingIntro({ ...merge, isAlum: person?.is_alum ?? false });
      openCompose({
        ...opts,
        subject: intro.subject,
        bodyHtml: intro.bodyHtml,
        isIntro: true,
        templateFollowUps: renderOnboardingFollowUps(merge),
      });
    },
    [onboardingOutreach, tabs, company, user, openCompose, affinity.university],
  );

  const handleSetTier = async (person: CompanyPerson, tier: ContactTier) => {
    try {
      if (tier === "active") await activateContact(person.contact_id);
      else if (tier === "prospect") await promoteContactToProspect(person.contact_id);
      else await demoteContactToBench(person.contact_id);
      // A tier move changes the current/former/bench split, and with it the
      // company's contact counts, traction, and lead name on the list card.
      // The list is unmounted here, so it is invalidated at the write (CAR-256).
      if (user) {
        invalidateCompaniesList(user.id);
        // A tier move changes network_status, which moves this person's bucket
        // on EVERY company they hold a role at, not just this one (CAR-268).
        invalidateCompanyScopes();
      }
      toastSuccess(
        tier === "active"
          ? `${person.name} added to your network`
          : tier === "prospect"
            ? `${person.name} moved to prospects`
            : `${person.name} archived`,
      );
      await load();
    } catch {
      toastError("Failed to move contact");
    }
  };

  if (!user) return null;

  const body = () => {
    if (notFound) {
      return (
        <p className="py-16 text-center text-sm text-on-surface-variant">Company not found.</p>
      );
    }
    // Gated on the ROSTER only (CAR-268). The pipeline arrives on its own and
    // carries its own skeleton, so a cached roster paints immediately instead
    // of waiting on a read it does not depend on.
    if (scopesLoading || !company || !tabs) {
      return <p className="py-16 text-center text-sm text-on-surface-variant">Loading…</p>;
    }
    return (
      <>
        {onboardingOutreach && (
          <div className="onboarding-cue mb-5 flex items-start gap-3 p-4 rounded-2xl bg-primary/8 border border-primary/25">
            <Mail className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="flex-1">
              {gmailConnected ? (
                <>
                  <p className="text-sm font-medium text-foreground">
                    Pick a prospect and hit their email button
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Your intro is pre-written{affinity.hasAffinity ? ", and fellow alumni get the alumni version" : ""}. Edit anything,
                    then send or schedule. Follow-ups come ready too.
                  </p>
                </>
              ) : (
                // Without Gmail every email button on this page is inert —
                // the nudge must offer the connect, not promise a dead button.
                <>
                  <p className="text-sm font-medium text-foreground">
                    Connect Gmail to send your first pre-written intro
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Your intro and follow-ups are ready, just one connection away. You&apos;ll come
                    right back to this page.
                  </p>
                  <a
                    href={`/api/gmail/auth?returnTo=${encodeURIComponent(`/companies/${companyId}`)}`}
                    className="inline-flex items-center gap-2 mt-2.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Connect Gmail & Calendar
                  </a>
                </>
              )}
            </div>
          </div>
        )}
        <PipelineLayout
        userId={user.id}
        companyId={companyId}
        tabs={tabs}
        companyName={company.name}
        totalContacts={totalContacts}
        linkedinUrl={company.linkedin_url}
        offices={offices}
        state={state}
        pipelineFailed={pipelineFailed}
        onRetryPipeline={loadPipelineState}
        actions={actions}
        saveStatus={saveStatus}
        scope={scope}
        onScopeChange={setScope}
        gmailConnected={gmailConnected}
        onCompose={composeForOnboarding}
        highlightEmail={onboardingOutreach && gmailConnected}
        onSetTier={handleSetTier}
        jobChangeIds={jobChangeIds}
        onOfficesChanged={load}
      />
      </>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <button
          onClick={() => {
            // router.back() returns to the exact history entry, which is what
            // brings the companies list's filters and scroll position back with
            // it; a Link to /companies is a forward push that drops both
            // (CAR-256). Client-side route changes never set document.referrer,
            // so the in-app trail decides whether there is anything to go back
            // to. Same pattern as contacts/[id].
            if (hasInAppBackHistory()) router.back();
            else router.push("/companies");
          }}
          className="group inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-4 -ml-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-surface-container-high cursor-pointer"
        >
          {/* "Back", not "Companies": back() honestly returns wherever the user
              came from, which may be the outreach page. */}
          <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" /> Back
        </button>
        {body()}
      </main>
    </div>
  );
}

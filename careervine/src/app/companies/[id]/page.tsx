"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { useCompose } from "@/components/compose-email-context";
import { PipelineLayout } from "@/components/companies/pipeline/pipeline-layout";
import { usePipelineAutosave } from "@/hooks/use-pipeline-autosave";
import { fetchCompanyScopes, type LocationTabsData } from "@/lib/company-scopes";
import { loadPipeline, type LoadedPipeline } from "@/lib/pipeline-queries";
import {
  demoteContactToBench,
  promoteContactToProspect,
  type CompanyDetail,
  type CompanyPerson,
} from "@/lib/company-queries";
import { activateContact, getFreshJobChangeContactIds } from "@/lib/queries";
import type { ContactTier } from "@/components/companies/pipeline/pipeline-layout";
import { useOnboarding } from "@/components/onboarding/onboarding-context";
import {
  renderOnboardingIntro,
  renderOnboardingFollowUps,
} from "@/lib/onboarding/templates";
import { ArrowLeft, Mail } from "lucide-react";

/**
 * Company recruiting page (CAR-6): full contact roster on the left, the
 * per-scope recruiting pipeline on the right. Scope (company-wide vs a
 * specific office) lives in the ?location= query param.
 */
export default function CompanyPipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const companyId = Number(id);
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError, success: toastSuccess } = useToast();
  const { openCompose, gmailConnected } = useCompose();
  const { state: onboardingState } = useOnboarding();
  const onboardingOutreach = onboardingState === "outreach";

  const [company, setCompany] = useState<CompanyDetail["company"] | null>(null);
  const [tabs, setTabs] = useState<LocationTabsData | null>(null);
  const [offices, setOffices] = useState<CompanyDetail["offices"]>([]);
  const [totalContacts, setTotalContacts] = useState(0);
  const [target, setTarget] = useState<CompanyDetail["target"]>(null);
  const [loaded, setLoaded] = useState<LoadedPipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Bench contacts with an unactioned job-change event (plan 29 Q5 hint)
  const [jobChangeIds, setJobChangeIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!user || Number.isNaN(companyId)) return;
    setLoading(true);
    try {
      const [scopes, pipeline] = await Promise.all([
        fetchCompanyScopes(user.id, companyId),
        loadPipeline(user.id, companyId),
      ]);
      setCompany(scopes.company);
      setTabs(scopes.tabs);
      setOffices(scopes.offices);
      setTotalContacts(scopes.totalContacts);
      setTarget(scopes.target);
      setLoaded(pipeline);
      // Best-effort job-change hint data — never blocks the page
      getFreshJobChangeContactIds(scopes.tabs.all.bench.map((p) => p.contact_id))
        .then(setJobChangeIds)
        .catch(() => {});
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [user, companyId]);

  useEffect(() => {
    // load() catches its own failures into the not-found state
    void load();
  }, [load]);

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
  // template — alumni variant when the prospect is a BYU alum.
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
    [onboardingOutreach, tabs, company, user, openCompose],
  );

  const handleSetTier = async (person: CompanyPerson, tier: ContactTier) => {
    try {
      if (tier === "active") await activateContact(person.contact_id);
      else if (tier === "prospect") await promoteContactToProspect(person.contact_id);
      else await demoteContactToBench(person.contact_id);
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
    if (loading || !company || !tabs || !state) {
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
                    Your intro is pre-written, and BYU alumni get the alumni version. Edit anything,
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
        <Link
          href="/companies"
          className="group inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-4 -ml-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-surface-container-high"
        >
          <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" /> Companies
        </Link>
        {body()}
      </main>
    </div>
  );
}

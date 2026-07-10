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
import { activateContact } from "@/lib/queries";
import type { ContactTier } from "@/components/companies/pipeline/pipeline-layout";
import { ArrowLeft } from "lucide-react";

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

  const [company, setCompany] = useState<CompanyDetail["company"] | null>(null);
  const [tabs, setTabs] = useState<LocationTabsData | null>(null);
  const [offices, setOffices] = useState<CompanyDetail["offices"]>([]);
  const [totalContacts, setTotalContacts] = useState(0);
  const [target, setTarget] = useState<CompanyDetail["target"]>(null);
  const [loaded, setLoaded] = useState<LoadedPipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [user, companyId]);

  useEffect(() => {
    load();
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
      load();
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
        onCompose={openCompose}
        onSetTier={handleSetTier}
        onOfficesChanged={load}
      />
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

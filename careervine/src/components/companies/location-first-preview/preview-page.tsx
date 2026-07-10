"use client";

import type { ComponentType } from "react";
import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { fetchLocationBlocks, type PreviewLocationBlock, type LocationTabsData } from "@/lib/company-location-preview";
import type { PreviewVariantSlug } from "@/lib/company-location-preview";
import {
  PreviewBanner,
  CompanyHeaderThin,
} from "@/components/companies/location-first-preview/shared";
import { TabsLayout } from "@/components/companies/location-first-preview/tabs-layout";
import { PipelineLayout } from "@/components/companies/location-first-preview/pipeline-layout";
import { StackLayout } from "@/components/companies/location-first-preview/stack-layout";
import { CardsLayout } from "@/components/companies/location-first-preview/cards-layout";
import { AccordionLayout } from "@/components/companies/location-first-preview/accordion-layout";
import { SplitLayout } from "@/components/companies/location-first-preview/split-layout";

const LAYOUTS: Record<Exclude<PreviewVariantSlug, "tabs" | "pipeline">, ComponentType<{ blocks: PreviewLocationBlock[] }>> = {
  stack: StackLayout,
  cards: CardsLayout,
  accordion: AccordionLayout,
  split: SplitLayout,
};

export function LocationFirstPreviewPage({
  params,
  variant,
}: {
  params: Promise<{ id: string }>;
  variant: PreviewVariantSlug;
}) {
  const { id } = use(params);
  const companyId = Number(id);
  const { user } = useAuth();
  const [blocks, setBlocks] = useState<PreviewLocationBlock[]>([]);
  const [tabsData, setTabsData] = useState<LocationTabsData | null>(null);
  const [company, setCompany] = useState<{ name: string; linkedin_url: string | null } | null>(null);
  const [totalContacts, setTotalContacts] = useState(0);
  const [target, setTarget] = useState<Awaited<ReturnType<typeof fetchLocationBlocks>>["target"]>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user || Number.isNaN(companyId)) return;
    setLoading(true);
    try {
      const data = await fetchLocationBlocks(user.id, companyId);
      setCompany(data.company);
      setBlocks(data.blocks);
      setTabsData(data.tabs);
      setTotalContacts(data.totalContacts);
      setTarget(data.target);
    } finally {
      setLoading(false);
    }
  }, [user, companyId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!user) return null;

  const Layout = variant !== "tabs" && variant !== "pipeline" ? LAYOUTS[variant] : null;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      {company && (
        <PreviewBanner
          companyId={companyId}
          activeVariant={variant}
          companyName={company.name}
          minimal={variant === "tabs" || variant === "pipeline"}
        />
      )}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading || !company ? (
          <p className="text-sm text-on-surface-variant py-16 text-center">Loading preview…</p>
        ) : variant === "pipeline" && tabsData ? (
          <>
            <Link
              href={`/companies/${companyId}`}
              className="group inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-4 -ml-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-surface-container-high"
            >
              ← Companies
            </Link>
            <PipelineLayout
              companyId={companyId}
              tabs={tabsData}
              companyName={company.name}
              totalContacts={totalContacts}
              linkedinUrl={company.linkedin_url}
              target={target}
            />
          </>
        ) : variant === "tabs" && tabsData ? (
          <>
            <CompanyHeaderThin
              companyId={companyId}
              name={company.name}
              totalContacts={totalContacts}
              linkedinUrl={company.linkedin_url}
              forTabs
            />
            <TabsLayout tabs={tabsData} />
          </>
        ) : Layout ? (
          <>
            <CompanyHeaderThin
              companyId={companyId}
              name={company.name}
              totalContacts={totalContacts}
              linkedinUrl={company.linkedin_url}
            />
            <Layout blocks={blocks} />
          </>
        ) : null}
      </main>
    </div>
  );
}

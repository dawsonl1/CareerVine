/**
 * Live stats for the onboarding bundle offer + progress modal (CAR-50).
 *
 * Counts are read from data_bundles (denormalized at publish) and the
 * bundle_alumni_stats() SQL function — never hardcoded, so a bundle
 * republish updates the modal copy automatically.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

// The curated APM bundle is the default onboarding seed. If it's ever
// renamed/replaced, the newest published bundle is the fallback, so
// onboarding degrades gracefully instead of dead-ending.
const ONBOARDING_BUNDLE_SLUG = "apm-data-bundle";

export type OnboardingBundleStats = {
  bundleId: number;
  slug: string;
  name: string;
  description: string | null;
  prospectCount: number;
  companyCount: number;
  alumniCount: number;
  alumniCompanyCount: number;
};

export async function getOnboardingBundleStats(): Promise<OnboardingBundleStats | null> {
  const supabase = createSupabaseBrowserClient();

  const { data: bundles, error } = await supabase
    .from("data_bundles")
    .select("id, slug, name, description, prospect_count, company_count, published_at")
    .eq("status", "published")
    .order("published_at", { ascending: false });
  if (error || !bundles?.length) return null;

  const bundle = bundles.find((b) => b.slug === ONBOARDING_BUNDLE_SLUG) ?? bundles[0];

  let alumniCount = 0;
  let alumniCompanyCount = 0;
  const { data: stats } = await supabase.rpc("bundle_alumni_stats", {
    p_bundle_id: bundle.id,
  });
  const row = Array.isArray(stats) ? stats[0] : stats;
  if (row) {
    alumniCount = Number(row.alumni_count) || 0;
    alumniCompanyCount = Number(row.alumni_company_count) || 0;
  }

  return {
    bundleId: bundle.id,
    slug: bundle.slug,
    name: bundle.name,
    description: bundle.description,
    prospectCount: bundle.prospect_count,
    companyCount: bundle.company_count,
    alumniCount,
    alumniCompanyCount,
  };
}

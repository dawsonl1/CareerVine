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
  /** Alumni whose pipeline persona is a product role (CAR-61). */
  alumniProductCount: number;
  /** How many of the bundle's companies have a BYU alum there today — a
   * subset of companyCount by construction (CAR-61). */
  alumniCompanyCount: number;
  /**
   * How many prospects a subscriber with NO alumni affinity actually receives
   * (CAR-213). Bundle-wide, so it is the correct denominator for a progress
   * bar; the per-company sums from bundle_company_stats are NOT, because they
   * only count prospects whose employer is one of the bundle's companies and
   * come to roughly half the total.
   *
   * Falls back to prospectCount, which is exactly right for a BYU-family user
   * and is the pre-CAR-213 behaviour for everyone else — a failed stat read
   * degrades to a bar that finishes early, never one that never finishes.
   */
  eligibleProspectCount: number;
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
  let alumniProductCount = 0;
  let alumniCompanyCount = 0;
  let eligibleProspectCount = bundle.prospect_count;
  // error-tolerated: the alumni counts are onboarding copy that already
  // defaults to 0; a failed read shows the bundle without its stat line rather
  // than blocking onboarding.
  const { data: stats } = await supabase.rpc("bundle_alumni_stats", {
    p_bundle_id: bundle.id,
  });
  const row = Array.isArray(stats) ? stats[0] : stats;
  if (row) {
    alumniCount = Number(row.alumni_count) || 0;
    alumniProductCount = Number(row.alumni_product_count) || 0;
    alumniCompanyCount = Number(row.alumni_company_count) || 0;
    // `|| fallback` rather than `?? fallback`: a genuine 0 would mean the user
    // receives nothing, which this bundle cannot produce, and would render a
    // bar that can never move.
    eligibleProspectCount = Number(row.eligible_prospect_count) || bundle.prospect_count;
  }

  return {
    bundleId: bundle.id,
    slug: bundle.slug,
    name: bundle.name,
    description: bundle.description,
    prospectCount: bundle.prospect_count,
    companyCount: bundle.company_count,
    alumniCount,
    alumniProductCount,
    alumniCompanyCount,
    eligibleProspectCount,
  };
}

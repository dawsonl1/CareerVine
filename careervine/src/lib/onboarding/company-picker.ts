/**
 * Company list for the onboarding "pick a target company" step (CAR-50),
 * ranked by BYU-alumni count so the warmest doors sort first.
 *
 * Since CAR-77 the list comes from BUNDLE-level data (bundle_company_stats,
 * subscriber-scoped via RLS) instead of the user's synced contacts: every
 * number is knowable the moment the subscription exists, so the picker
 * renders instantly while the sync streams in — and the counts are identical
 * before and after the sync, so nothing flickers when it finishes.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";

export type PickerCompany = {
  id: number;
  name: string;
  logoUrl: string | null;
  contactCount: number;
  alumniCount: number;
  /** Alumni whose pipeline persona is a product role (CAR-61). */
  productAlumniCount: number;
};

interface BundleCompanyStatsRow {
  company_id: number;
  name: string;
  logo_url: string | null;
  prospect_count: number | string;
  alumni_count: number | string;
  product_alumni_count: number | string;
}

/** Map + rank raw RPC rows. Exported for tests. */
export function toPickerCompanies(rows: BundleCompanyStatsRow[] | null): PickerCompany[] {
  return (rows ?? [])
    .map((row) => ({
      id: row.company_id,
      name: row.name,
      logoUrl: row.logo_url,
      contactCount: Number(row.prospect_count) || 0,
      alumniCount: Number(row.alumni_count) || 0,
      productAlumniCount: Number(row.product_alumni_count) || 0,
    }))
    .filter((c) => c.contactCount > 0)
    .sort(
      (a, b) =>
        b.alumniCount - a.alumniCount ||
        b.productAlumniCount - a.productAlumniCount ||
        b.contactCount - a.contactCount ||
        a.name.localeCompare(b.name),
    );
}

export async function getPickerCompanies(bundleId: number): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.rpc("bundle_company_stats", { p_bundle_id: bundleId });
  return toPickerCompanies((data as BundleCompanyStatsRow[] | null) ?? null);
}

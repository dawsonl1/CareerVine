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

/** User-selectable ordering for the picker's "Order by" dropdown. */
export type CompanySortKey = "alumni" | "productAlumni" | "contacts" | "alphabetical";

/** Options for the "Order by" dropdown, in display order. */
export const COMPANY_SORT_OPTIONS: { value: CompanySortKey; label: string }[] = [
  { value: "alumni", label: "Most BYU alumni" },
  { value: "productAlumni", label: "Most alumni in product roles" },
  { value: "contacts", label: "Most contacts" },
  { value: "alphabetical", label: "Alphabetical" },
];

const byName = (a: PickerCompany, b: PickerCompany) => a.name.localeCompare(b.name);

// Each key leads with its headline metric, then falls through the other
// signals so ties still surface the warmest doors before an alpha tiebreak.
const COMPARATORS: Record<CompanySortKey, (a: PickerCompany, b: PickerCompany) => number> = {
  alumni: (a, b) =>
    b.alumniCount - a.alumniCount ||
    b.productAlumniCount - a.productAlumniCount ||
    b.contactCount - a.contactCount ||
    byName(a, b),
  productAlumni: (a, b) =>
    b.productAlumniCount - a.productAlumniCount ||
    b.alumniCount - a.alumniCount ||
    b.contactCount - a.contactCount ||
    byName(a, b),
  contacts: (a, b) =>
    b.contactCount - a.contactCount ||
    b.alumniCount - a.alumniCount ||
    b.productAlumniCount - a.productAlumniCount ||
    byName(a, b),
  alphabetical: byName,
};

/** Re-order an already-mapped picker list without mutating the input. */
export function sortPickerCompanies(companies: PickerCompany[], key: CompanySortKey): PickerCompany[] {
  return [...companies].sort(COMPARATORS[key]);
}

/**
 * Map + rank raw RPC rows. Exported for tests. Defaults to the "alumni"
 * ordering (warmest doors first); the picker lets the user re-sort in place.
 */
export function toPickerCompanies(rows: BundleCompanyStatsRow[] | null): PickerCompany[] {
  const mapped = (rows ?? [])
    .map((row) => ({
      id: row.company_id,
      name: row.name,
      logoUrl: row.logo_url,
      contactCount: Number(row.prospect_count) || 0,
      alumniCount: Number(row.alumni_count) || 0,
      productAlumniCount: Number(row.product_alumni_count) || 0,
    }))
    .filter((c) => c.contactCount > 0);
  return sortPickerCompanies(mapped, "alumni");
}

export async function getPickerCompanies(bundleId: number): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.rpc("bundle_company_stats", { p_bundle_id: bundleId });
  return toPickerCompanies((data as BundleCompanyStatsRow[] | null) ?? null);
}

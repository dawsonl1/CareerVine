/**
 * Company list for the onboarding "pick a target company" step (CAR-50),
 * ranked by alumni count so the warmest doors sort first — for a user who
 * has alumni. Everyone else leads with raw reach (CAR-213).
 *
 * Since CAR-77 the list comes from BUNDLE-level data (bundle_company_stats,
 * subscriber-scoped via RLS) instead of the user's synced contacts: every
 * number is knowable the moment the subscription exists, so the picker
 * renders instantly while the sync streams in — and the counts are identical
 * before and after the sync, so nothing flickers when it finishes.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { must } from "@/lib/data/client";

export type PickerCompany = {
  id: number;
  name: string;
  logoUrl: string | null;
  contactCount: number;
  /** Prospects a non-affinity subscriber actually receives here (CAR-213).
   * Companies where this is 0 are dropped from the picker rather than shown
   * as "0 contacts". */
  eligibleContactCount: number;
  alumniCount: number;
  /** Alumni whose pipeline persona is a product role (CAR-61). */
  productAlumniCount: number;
};

interface BundleCompanyStatsRow {
  company_id: number;
  name: string;
  logo_url: string | null;
  prospect_count: number | string;
  eligible_prospect_count: number | string;
  alumni_count: number | string;
  product_alumni_count: number | string;
}

/** User-selectable ordering for the picker's "Order by" dropdown. */
export type CompanySortKey = "alumni" | "productAlumni" | "contacts" | "alphabetical";

/**
 * Options for the "Order by" dropdown, in display order.
 *
 * The two alumni orderings are HIDDEN, not disabled, for a user with no
 * alumni affinity (CAR-213): their bundle contains no alumni-only prospects,
 * so both orderings would be meaningless, and a disabled control invites the
 * question "why can't I use this?" that the dropdown cannot answer.
 *
 * `abbr` names the user's own school, so a USU student sees "Most USU alumni".
 * Null for an escape-hatch school with no curated abbreviation, where the
 * label falls back to the school-less form.
 */
export function companySortOptions(
  hasAffinity: boolean,
  abbr: string | null,
): { value: CompanySortKey; label: string }[] {
  const base: { value: CompanySortKey; label: string }[] = [
    { value: "contacts", label: "Most contacts" },
    { value: "alphabetical", label: "Alphabetical" },
  ];
  if (!hasAffinity) return base;
  return [
    { value: "alumni", label: abbr ? `Most ${abbr} alumni` : "Most alumni" },
    { value: "productAlumni", label: "Most alumni in product roles" },
    ...base,
  ];
}

/** The ordering a picker opens on. Alumni are the warmest door only for a
 * user who has them; everyone else leads with raw reach. */
export function defaultCompanySortKey(hasAffinity: boolean): CompanySortKey {
  return hasAffinity ? "alumni" : "contacts";
}

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
export function toPickerCompanies(
  rows: BundleCompanyStatsRow[] | null,
  hasAffinity = true,
): PickerCompany[] {
  const mapped = (rows ?? [])
    .map((row) => ({
      id: row.company_id,
      name: row.name,
      logoUrl: row.logo_url,
      contactCount: Number(row.prospect_count) || 0,
      eligibleContactCount: Number(row.eligible_prospect_count) || 0,
      alumniCount: Number(row.alumni_count) || 0,
      productAlumniCount: Number(row.product_alumni_count) || 0,
    }))
    // Count what the viewer will actually receive. Filtering on the raw
    // prospect count would leave a non-affinity user staring at the 12
    // companies whose every prospect was alumni-only, each showing "0
    // contacts" with no way to tell why.
    .filter((c) => (hasAffinity ? c.contactCount : c.eligibleContactCount) > 0)
    .map((c) => (hasAffinity ? c : { ...c, contactCount: c.eligibleContactCount }));
  return sortPickerCompanies(mapped, defaultCompanySortKey(hasAffinity));
}

export async function getPickerCompanies(
  bundleId: number,
  hasAffinity = true,
): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const data = must(await supabase.rpc("bundle_company_stats", { p_bundle_id: bundleId }));
  return toPickerCompanies((data as BundleCompanyStatsRow[] | null) ?? null, hasAffinity);
}

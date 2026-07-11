/**
 * Company list for the onboarding "pick a target company" step (CAR-50),
 * ranked by BYU-alumni count so the warmest doors sort first.
 *
 * Two sources feed the same shape (CAR-77):
 *  - getBundlePickerCompanies — bundle-level stats that exist the moment the
 *    subscription row is created, so the picker renders instantly while the
 *    sync is still copying contacts;
 *  - getPickerCompanies — the user's own synced contacts, kept as the
 *    fallback for a resumed pick_company session where bundle stats can't
 *    resolve (e.g. the bundle was unpublished later).
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { getCompanies } from "@/lib/company-queries";

export type PickerCompany = {
  id: number;
  name: string;
  logoUrl: string | null;
  contactCount: number;
  alumniCount: number;
  /** Alumni whose pipeline persona is a product role (CAR-61). */
  productAlumniCount: number;
};

/** Warmest doors first: alumni, then product-role alumni, then sheer size. */
export function comparePickerCompanies(a: PickerCompany, b: PickerCompany): number {
  return (
    b.alumniCount - a.alumniCount ||
    b.productAlumniCount - a.productAlumniCount ||
    b.contactCount - a.contactCount ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Bundle-level company list (CAR-77): per-company prospect/alumni counts from
 * bundle_company_stats(). Subscriber-scoped by RLS — returns [] until the
 * caller's subscription row exists.
 */
export async function getBundlePickerCompanies(bundleId: number): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase.rpc("bundle_company_stats", { p_bundle_id: bundleId });
  const rows =
    (data as
      | {
          company_id: number;
          name: string;
          logo_url: string | null;
          prospect_count: number;
          alumni_count: number;
          product_alumni_count: number;
        }[]
      | null) ?? [];

  return rows
    .map((row) => ({
      id: row.company_id,
      name: row.name,
      logoUrl: row.logo_url,
      contactCount: Number(row.prospect_count) || 0,
      alumniCount: Number(row.alumni_count) || 0,
      productAlumniCount: Number(row.product_alumni_count) || 0,
    }))
    .sort(comparePickerCompanies);
}

export async function getPickerCompanies(userId: string): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const [companies, alumniRes] = await Promise.all([
    getCompanies(userId, { targetsOnly: false, minContacts: 1 }),
    supabase.rpc("user_company_alumni_counts"),
  ]);

  const alumniByCompany = new Map<number, { alumni: number; product: number }>();
  const rows =
    (alumniRes.data as
      | { company_id: number; alumni_count: number; product_alumni_count: number }[]
      | null) ?? [];
  for (const row of rows) {
    alumniByCompany.set(row.company_id, {
      alumni: Number(row.alumni_count) || 0,
      product: Number(row.product_alumni_count) || 0,
    });
  }

  return companies
    .map((c) => ({
      id: c.id,
      name: c.name,
      logoUrl: c.logo_url,
      contactCount: c.current_count,
      alumniCount: alumniByCompany.get(c.id)?.alumni ?? 0,
      productAlumniCount: alumniByCompany.get(c.id)?.product ?? 0,
    }))
    .filter((c) => c.contactCount > 0)
    .sort(comparePickerCompanies);
}

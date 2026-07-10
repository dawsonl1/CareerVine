/**
 * Company list for the onboarding "pick a target company" step (CAR-50):
 * every company the user now has contacts at (fresh from the bundle apply),
 * ranked by BYU-alumni count so the warmest doors sort first.
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
  alreadyTargeted: boolean;
};

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
      alreadyTargeted: c.target != null,
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

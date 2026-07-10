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
  alreadyTargeted: boolean;
};

export async function getPickerCompanies(userId: string): Promise<PickerCompany[]> {
  const supabase = createSupabaseBrowserClient();
  const [companies, alumniRes] = await Promise.all([
    getCompanies(userId, { targetsOnly: false, minContacts: 1 }),
    supabase.rpc("user_company_alumni_counts"),
  ]);

  const alumniByCompany = new Map<number, number>();
  for (const row of (alumniRes.data as { company_id: number; alumni_count: number }[] | null) ?? []) {
    alumniByCompany.set(row.company_id, Number(row.alumni_count) || 0);
  }

  return companies
    .map((c) => ({
      id: c.id,
      name: c.name,
      logoUrl: c.logo_url,
      contactCount: c.current_count,
      alumniCount: alumniByCompany.get(c.id) ?? 0,
      alreadyTargeted: c.target != null,
    }))
    .filter((c) => c.contactCount > 0)
    .sort(
      (a, b) =>
        b.alumniCount - a.alumniCount ||
        b.contactCount - a.contactCount ||
        a.name.localeCompare(b.name),
    );
}

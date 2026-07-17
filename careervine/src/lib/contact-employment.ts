/**
 * Batch-load current employment for contacts (title, company, office).
 * Used by Outreach / Inbox to enrich email rows without N+1 client fetches (CAR-127).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { chunked } from "@/lib/data/postgrest";

export type ContactEmployment = {
  id: number;
  name: string;
  title: string | null;
  company_id: number | null;
  company_name: string | null;
  /** Office label: city/state, legacy free-text location, or "Remote". */
  location_label: string | null;
};

type ServiceClient = SupabaseClient<Database>;

function locationLabel(
  loc: { city: string | null; state: string | null; country: string } | null | undefined,
): string | null {
  if (!loc) return null;
  if (loc.city) return [loc.city, loc.state].filter(Boolean).join(", ");
  if (loc.state) return [loc.state, loc.country].filter(Boolean).join(", ");
  return loc.country || null;
}

function officeLabel(row: {
  location: string | null;
  workplace_type: string | null;
  locations: { city: string | null; state: string | null; country: string } | null;
}): string | null {
  return (
    locationLabel(row.locations) ||
    (row.location?.trim() || null) ||
    (row.workplace_type === "remote" ? "Remote" : null)
  );
}

/** Resolve recipient emails → contact ids for this user (case-insensitive). */
export async function resolveEmailsToContactIds(
  service: ServiceClient,
  userId: string,
  emails: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const variants = new Set<string>();
  for (const raw of emails) {
    const e = raw?.trim();
    if (!e) continue;
    variants.add(e);
    variants.add(e.toLowerCase());
  }
  const map = new Map<string, number>();
  if (variants.size === 0) return map;

  const list = [...variants];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await service
      .from("contact_emails")
      .select("email, contact_id, contacts!inner(user_id)")
      .eq("contacts.user_id", userId)
      .in("email", chunk);
    if (error) throw error;
    for (const row of data || []) {
      if (row.email && row.contact_id != null) {
        map.set(String(row.email).toLowerCase(), row.contact_id);
      }
    }
  }
  return map;
}

/**
 * Load name + current role/company/office for the given contact ids.
 * Only `is_current` employment rows are used.
 */
export async function loadContactEmploymentMap(
  service: ServiceClient,
  userId: string,
  contactIds: number[],
): Promise<Record<number, ContactEmployment>> {
  const unique = [...new Set(contactIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out: Record<number, ContactEmployment> = {};
  if (unique.length === 0) return out;

  const contacts = await chunked(unique, async (chunk) => {
    const { data, error } = await service
      .from("contacts")
      .select("id, name")
      .eq("user_id", userId)
      .in("id", chunk);
    if (error) throw error;
    return data || [];
  });

  for (const c of contacts) {
    out[c.id] = {
      id: c.id,
      name: c.name || "Unknown",
      title: null,
      company_id: null,
      company_name: null,
      location_label: null,
    };
  }

  const jobs = await chunked(unique, async (chunk) => {
    const { data, error } = await service
      .from("contact_companies")
      .select(
        "contact_id, title, location, workplace_type, locations(city, state, country), companies(id, name)",
      )
      .eq("is_current", true)
      .in("contact_id", chunk);
    if (error) throw error;
    return data || [];
  });

  for (const row of jobs) {
    const entry = out[row.contact_id];
    if (!entry) continue;
    entry.title = row.title || null;
    entry.company_id = row.companies?.id ?? null;
    entry.company_name = row.companies?.name ?? null;
    entry.location_label = officeLabel(row);
  }

  return out;
}

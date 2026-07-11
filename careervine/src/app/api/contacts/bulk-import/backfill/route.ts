/**
 * POST /api/contacts/bulk-import/backfill — plan 24 §2h.
 *
 * Two re-runnable maintenance passes over scraped employment rows (the
 * load script calls this once after all chunks; safe to run any time):
 *
 * 1. Rule-2 backfill: current scraped roles with no location whose
 *    contact has a profile location matching a now-known company office
 *    get claimed (location_source='profile_match'). Mops up cross-chunk
 *    ordering effects — an office established by chunk 9 claims a person
 *    imported in chunk 2.
 * 2. Re-normalization: when the alias map improves, experience-sourced
 *    locations re-derive from location_raw. Never touches manual rows.
 */

import { withApiHandler } from "@/lib/api-handler";
import { handleOptions } from "@/lib/extension-auth";
import {
  normalizeLocation,
  normalizeParsedLocation,
  locationMatchKey,
} from "@/lib/location-normalizer";
import { findOrCreateLocation, ensureCompanyLocation } from "@/lib/company-helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 60;

export async function OPTIONS() {
  return handleOptions();
}

interface LocationTriple {
  city: string | null;
  state: string | null;
  country: string;
}

/** company_id → (locationMatchKey → location_id) for the given companies. */
async function loadOfficeMaps(
  supabase: SupabaseClient,
  companyIds: number[],
): Promise<Map<number, Map<string, number>>> {
  const maps = new Map<number, Map<string, number>>();
  if (companyIds.length === 0) return maps;
  const { data } = await supabase
    .from("company_locations")
    .select("company_id, location_id, locations(city, state, country)")
    .in("company_id", companyIds);
  for (const row of (data as Array<{ company_id: number; location_id: number; locations: LocationTriple | null }> | null) ?? []) {
    if (!row.locations) continue;
    const key = locationMatchKey(normalizeParsedLocation(row.locations));
    if (!key) continue;
    let m = maps.get(row.company_id);
    if (!m) {
      m = new Map();
      maps.set(row.company_id, m);
    }
    if (!m.has(key)) m.set(key, row.location_id);
  }
  return maps;
}

export const POST = withApiHandler({
  extensionAuth: true,
  stampExtensionSeen: false, // ops-script/web-driven — a bulk run is not an "extension connected" signal (CAR-68)
  cors: true,
  handler: async ({ supabase, user }) => {
    // ── Pass 1: rule-2 backfill ──
    const { data: candidates } = await supabase
      .from("contact_companies")
      .select("id, company_id, workplace_type, contacts!inner(user_id, location_id, locations(city, state, country))")
      .eq("contacts.user_id", user.id)
      .eq("is_current", true)
      .eq("source", "scraped")
      .is("location_id", null);

    type CandidateRow = {
      id: number;
      company_id: number;
      workplace_type: string | null;
      contacts: { user_id: string; location_id: number | null; locations: LocationTriple | null };
    };
    const rows = ((candidates as CandidateRow[] | null) ?? []).filter(
      (r) => r.workplace_type !== "remote" && r.contacts?.locations,
    );

    const officeMaps = await loadOfficeMaps(supabase, [...new Set(rows.map((r) => r.company_id))]);

    let rule2Updated = 0;
    for (const row of rows) {
      const profileKey = locationMatchKey(normalizeParsedLocation(row.contacts.locations!));
      if (!profileKey) continue;
      const officeLocation = officeMaps.get(row.company_id)?.get(profileKey);
      if (officeLocation == null) continue;
      const { error } = await supabase
        .from("contact_companies")
        .update({ location_id: officeLocation, location_source: "profile_match" })
        .eq("id", row.id);
      if (!error) rule2Updated++;
    }

    // ── Pass 2: re-normalize experience locations from location_raw ──
    const { data: expRows } = await supabase
      .from("contact_companies")
      .select("id, company_id, location_id, location_raw, contacts!inner(user_id)")
      .eq("contacts.user_id", user.id)
      .eq("source", "scraped")
      .eq("location_source", "experience")
      .not("location_raw", "is", null);

    // Current location triples, to detect drift without a per-row query
    type ExpRow = { id: number; company_id: number; location_id: number | null; location_raw: string | null };
    const expList = (expRows as ExpRow[] | null) ?? [];
    const locationIds = [...new Set(expList.map((r) => r.location_id).filter((v): v is number => v != null))];
    const { data: locRows } = locationIds.length
      ? await supabase.from("locations").select("id, city, state, country").in("id", locationIds)
      : { data: [] };
    const locById = new Map(
      (((locRows as Array<{ id: number } & LocationTriple> | null) ?? [])).map((l) => [l.id, l]),
    );

    let renormalized = 0;
    for (const row of expList) {
      if (!row.location_raw) continue;
      const norm = normalizeLocation(row.location_raw);
      const newKey = locationMatchKey(norm);
      if (!newKey) continue; // alias map no longer resolves it — leave as-is
      const current = row.location_id != null ? locById.get(row.location_id) : null;
      const currentKey = current ? locationMatchKey(normalizeParsedLocation(current)) : null;
      if (newKey === currentKey) continue;

      const { id: newLocationId } = await findOrCreateLocation(supabase, {
        city: norm.city,
        state: norm.state,
        country: norm.country ?? "United States",
      });
      const { error } = await supabase
        .from("contact_companies")
        .update({ location_id: newLocationId })
        .eq("id", row.id);
      if (!error) {
        await ensureCompanyLocation(supabase, row.company_id, newLocationId, "scraped");
        renormalized++;
      }
    }

    return { rule2_updated: rule2Updated, renormalized };
  },
});

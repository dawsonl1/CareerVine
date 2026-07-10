/**
 * Consolidated company / location find-or-create helpers.
 *
 * Replaces the two divergent implementations that existed before plan 24:
 * queries.ts findOrCreateCompany (case-sensitive eq) and the extension
 * import route (unescaped ilike where % and _ acted as wildcards).
 *
 * Company matching order:
 *  1. linkedin_company_id (stable LinkedIn numeric id) — the primary key
 *     for scraped data.
 *  2. Normalized name match (trimmed, ESCAPED ilike).
 *     When a scraped companyId is in hand, the name-matched row is
 *     "claimed" by backfilling linkedin_company_id (requires the
 *     companies UPDATE RLS policy added in the plan-24 migration).
 *  3. Insert. Unique-violation races resolve by refetch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Escape %, _ and \ so user data can't act as ilike wildcards. */
export function escapeIlike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

export interface CompanyInput {
  name?: string | null;
  linkedin_company_id?: string | null;
  linkedin_url?: string | null;
  universal_name?: string | null;
  logo_url?: string | null;
}

export interface CompanyRecord {
  id: number;
  name: string;
  linkedin_company_id: string | null;
  linkedin_url: string | null;
  universal_name: string | null;
  logo_url: string | null;
}

const COMPANY_COLS = "id, name, linkedin_company_id, linkedin_url, universal_name, logo_url";

function normalizeCompanyLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function normalizeUniversalName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/** Display name for companies that arrive with an id but no name. */
export function companyFallbackName(input: CompanyInput): string | null {
  const name = input.name?.trim();
  if (name) return name;
  if (input.universal_name) return input.universal_name;
  if (input.linkedin_company_id) return `linkedin:${input.linkedin_company_id}`;
  return null;
}

export async function findOrCreateCompany(
  supabase: SupabaseClient,
  input: CompanyInput,
): Promise<CompanyRecord> {
  const companyId = input.linkedin_company_id?.trim() || null;
  const linkedinUrl = normalizeCompanyLinkedinUrl(input.linkedin_url);
  const universalName = normalizeUniversalName(input.universal_name);
  const name = companyFallbackName(input);
  if (!name && !companyId) throw new Error("findOrCreateCompany requires a name or linkedin_company_id");

  // 1. Stable-id match
  if (companyId) {
    const { data } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("linkedin_company_id", companyId)
      .maybeSingle();
    if (data) return data as CompanyRecord;
  }

  // 2. LinkedIn URL match
  if (linkedinUrl) {
    const { data: byUrl } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("linkedin_url", escapeIlike(linkedinUrl))
      .limit(1);
    const existing = (byUrl as CompanyRecord[] | null)?.[0];
    if (existing) {
      if (companyId && !existing.linkedin_company_id) {
        return await claimCompanyRow(supabase, existing, input, companyId);
      }
      return existing;
    }
  }

  // 3. LinkedIn universal_name match
  if (universalName) {
    const { data: byUniversal } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("universal_name", escapeIlike(universalName))
      .limit(1);
    const existing = (byUniversal as CompanyRecord[] | null)?.[0];
    if (existing) {
      if (companyId && !existing.linkedin_company_id) {
        return await claimCompanyRow(supabase, existing, input, companyId);
      }
      return existing;
    }
  }

  // 4. Name match (escaped ilike). limit(1): case variants could coexist.
  if (name) {
    const { data: byName } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("name", escapeIlike(name))
      .limit(1);
    const existing = (byName as CompanyRecord[] | null)?.[0];
    if (existing) {
      if (companyId && !existing.linkedin_company_id) {
        return await claimCompanyRow(supabase, existing, input, companyId);
      }
      return existing;
    }
  }

  // 3. Insert
  const insertData = {
    name: name!,
    linkedin_company_id: companyId,
    linkedin_url: linkedinUrl,
    universal_name: universalName,
    logo_url: input.logo_url?.trim() || null,
  };
  const { data: created, error } = await supabase
    .from("companies")
    .insert(insertData)
    .select(COMPANY_COLS)
    .single();
  if (!error && created) return created as CompanyRecord;

  // Unique-violation race (name or linkedin_company_id): refetch
  if (companyId) {
    const { data: retryById } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("linkedin_company_id", companyId)
      .maybeSingle();
    if (retryById) return retryById as CompanyRecord;
  }
  if (linkedinUrl) {
    const { data: retryByUrl } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("linkedin_url", escapeIlike(linkedinUrl))
      .limit(1);
    const retriedByUrl = (retryByUrl as CompanyRecord[] | null)?.[0];
    if (retriedByUrl) return retriedByUrl as CompanyRecord;
  }
  if (universalName) {
    const { data: retryByUniversal } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("universal_name", escapeIlike(universalName))
      .limit(1);
    const retriedByUniversal = (retryByUniversal as CompanyRecord[] | null)?.[0];
    if (retriedByUniversal) return retriedByUniversal as CompanyRecord;
  }
  const { data: retryByName } = await supabase
    .from("companies")
    .select(COMPANY_COLS)
    .ilike("name", escapeIlike(name!))
    .limit(1);
  const retried = (retryByName as CompanyRecord[] | null)?.[0];
  if (retried) return retried as CompanyRecord;
  throw error ?? new Error(`Failed to find or create company "${name}"`);
}

/** Backfill linkedin metadata onto a name-matched row. */
async function claimCompanyRow(
  supabase: SupabaseClient,
  existing: CompanyRecord,
  input: CompanyInput,
  companyId: string,
): Promise<CompanyRecord> {
  const patch: Record<string, unknown> = { linkedin_company_id: companyId };
  const linkedinUrl = normalizeCompanyLinkedinUrl(input.linkedin_url);
  const universalName = normalizeUniversalName(input.universal_name);
  if (!existing.linkedin_url && linkedinUrl) patch.linkedin_url = linkedinUrl;
  if (!existing.universal_name && universalName) patch.universal_name = universalName;
  if (!existing.logo_url && input.logo_url) patch.logo_url = input.logo_url.trim();

  const { data: updated, error } = await supabase
    .from("companies")
    .update(patch)
    .eq("id", existing.id)
    .is("linkedin_company_id", null) // claim only if still unclaimed (race guard)
    .select(COMPANY_COLS)
    .maybeSingle();
  if (updated) return updated as CompanyRecord;

  // Claim lost a race (someone else claimed this or another row got the id),
  // or the unique index rejected a duplicate id — fall back to the id owner.
  if (error || !updated) {
    const { data: owner } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("linkedin_company_id", companyId)
      .maybeSingle();
    if (owner) return owner as CompanyRecord;
  }
  return existing;
}

// ── Locations ──────────────────────────────────────────────────────────

export interface LocationInput {
  city: string | null;
  state: string | null;
  country: string;
}

/**
 * NULL-aware find-or-create on locations (city+state+country unique).
 * Consolidates the copies that lived in queries.ts and the import route.
 */
export async function findOrCreateLocation(
  supabase: SupabaseClient,
  location: LocationInput,
): Promise<{ id: number }> {
  function buildLookup() {
    let q = supabase.from("locations").select("id");
    q = location.city ? q.eq("city", location.city) : q.is("city", null);
    q = location.state ? q.eq("state", location.state) : q.is("state", null);
    return q.eq("country", location.country);
  }

  const { data: existing } = await buildLookup().maybeSingle();
  if (existing) return existing as { id: number };

  const { data, error } = await supabase
    .from("locations")
    .insert({ city: location.city, state: location.state, country: location.country })
    .select("id")
    .single();
  if (error) {
    const { data: retry } = await buildLookup().maybeSingle();
    if (retry) return retry as { id: number };
    throw error;
  }
  return data as { id: number };
}

/**
 * Register an office for a company (import rule 1). Idempotent — the
 * UNIQUE(company_id, location_id) conflict is ignored, so re-imports and
 * concurrent chunks are safe. Never updates existing rows (a manually
 * seeded office keeps source='manual').
 */
export async function ensureCompanyLocation(
  supabase: SupabaseClient,
  companyId: number,
  locationId: number,
  source: "scraped" | "manual" = "scraped",
): Promise<void> {
  const { error } = await supabase
    .from("company_locations")
    .upsert(
      { company_id: companyId, location_id: locationId, source },
      { onConflict: "company_id,location_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}

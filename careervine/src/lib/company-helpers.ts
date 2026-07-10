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

// NOTE: companies.domain was dropped in prod (20260709135000, CAR-6 branch) —
// selecting it 500s every company-resolution path. Do not re-add.
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

/** PostgREST selects are GETs — chunk .in() lists so URLs stay bounded. */
export function chunkList<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** True when a company input carries nothing but a display name — the only
 * shape whose match can safely short-circuit on an exact-name hit. */
export function isNameOnlyCompanyInput(input: CompanyInput): boolean {
  return (
    !input.linkedin_company_id?.trim() &&
    !normalizeCompanyLinkedinUrl(input.linkedin_url) &&
    !normalizeUniversalName(input.universal_name)
  );
}

/**
 * Chunk-level company prefetch (CAR-47): a handful of .in() queries instead
 * of a find-or-create round trip per company. Only two exact-match paths
 * short-circuit — stable linkedin_company_id, and exact name for inputs
 * that are NAME-ONLY (no id, no url, no universal_name). Anything carrying
 * a stronger identifier than its name must run findOrCreateCompany's full
 * chain on an id miss, because url/universal-name matches outrank name
 * matches there and id-bearing name matches trigger the claim logic.
 */
export async function prefetchCompanies(
  supabase: SupabaseClient,
  inputs: CompanyInput[],
): Promise<{ byId: Map<string, CompanyRecord>; byName: Map<string, CompanyRecord> }> {
  const byId = new Map<string, CompanyRecord>();
  const byName = new Map<string, CompanyRecord>();

  const ids = [...new Set(inputs.map((i) => i.linkedin_company_id?.trim()).filter(Boolean))] as string[];
  for (const chunk of chunkList(ids)) {
    const { data } = await supabase.from("companies").select(COMPANY_COLS).in("linkedin_company_id", chunk);
    for (const row of (data as CompanyRecord[] | null) ?? []) {
      if (row.linkedin_company_id) byId.set(row.linkedin_company_id, row);
    }
  }

  const names = [
    ...new Set(
      inputs
        .filter(isNameOnlyCompanyInput)
        .map((i) => companyFallbackName(i))
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  for (const chunk of chunkList(names)) {
    const { data } = await supabase.from("companies").select(COMPANY_COLS).in("name", chunk);
    for (const row of (data as CompanyRecord[] | null) ?? []) {
      const key = row.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, row);
    }
  }
  return { byId, byName };
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

/** Exact-equality lookup key mirroring findOrCreateLocation's filters. */
export const locationLookupKey = (l: { city: string | null; state: string | null; country: string }) =>
  `${l.city ?? ""}|${l.state ?? ""}|${l.country}`;

/**
 * Chunk-level location prefetch (CAR-47). Import location resolution only
 * ever runs for city-grain locations (locationMatchKey gates it), so one
 * city-keyed sweep covers a whole chunk; matching is the same exact
 * (city, state, country) equality findOrCreateLocation uses, and misses
 * fall back to it.
 */
export async function prefetchLocations(
  supabase: SupabaseClient,
  inputs: LocationInput[],
): Promise<Map<string, { id: number }>> {
  const out = new Map<string, { id: number }>();
  const wanted = new Set(inputs.map(locationLookupKey));
  const cities = [...new Set(inputs.map((i) => i.city).filter(Boolean))] as string[];
  for (const chunk of chunkList(cities)) {
    const { data } = await supabase.from("locations").select("id, city, state, country").in("city", chunk);
    for (const row of (data as Array<{ id: number; city: string | null; state: string | null; country: string }> | null) ?? []) {
      const key = locationLookupKey(row);
      if (wanted.has(key) && !out.has(key)) out.set(key, { id: row.id });
    }
  }
  return out;
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

/**
 * Bulk ensureCompanyLocation (CAR-47): one ignore-duplicates upsert for a
 * whole chunk of offices. A failed bulk write degrades to per-row so one
 * bad pair can't sink the rest.
 */
export async function ensureCompanyLocations(
  supabase: SupabaseClient,
  pairs: Array<{ company_id: number; location_id: number }>,
  source: "scraped" | "manual" = "scraped",
): Promise<void> {
  if (pairs.length === 0) return;
  const { error } = await supabase
    .from("company_locations")
    .upsert(
      pairs.map((p) => ({ ...p, source })),
      { onConflict: "company_id,location_id", ignoreDuplicates: true },
    );
  if (!error) return;
  for (const p of pairs) {
    await ensureCompanyLocation(supabase, p.company_id, p.location_id, source);
  }
}

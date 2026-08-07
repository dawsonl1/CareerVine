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
 *  2. linkedin_url (exact, trailing-slash-normalized, ESCAPED ilike).
 *  3. universal_name (exact, lowercased, ESCAPED ilike).
 *  4. Normalized name match via companies.name_normalized (CAR-44) —
 *     case/punctuation/legal-suffix-insensitive equality, never fuzzy.
 *     At 2–4, when a scraped companyId is in hand, the matched row is
 *     "claimed" by backfilling linkedin_company_id (requires the
 *     companies UPDATE RLS policy added in the plan-24 migration).
 *  5. Insert. Unique-violation races resolve by refetch. Identity-less
 *     inserts run a similarity probe and surface possible_duplicate_of.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkList, escapeIlike } from "@/lib/data/postgrest";
import { must, type QueryClient } from "@/lib/data/client";
import { findOrCreateLocation as findOrCreateLocationShared } from "@/lib/data/locations";

/**
 * Normalized company-name key: lowercase, every non-alphanumeric run
 * becomes one space, trim, strip trailing legal-suffix tokens. Matches
 * "Rubrik" ↔ "Rubrik, Inc." but deliberately NOT "Zoom" ↔ "Zoom Video
 * Communications" — conservative equality, never token-fuzzy (CAR-44).
 *
 * MUST stay in sync with the SQL expression behind
 * companies.name_normalized (migration 20260710170000).
 */
const LEGAL_SUFFIX_TOKENS =
  "inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|company|lp|plc|gmbh|pllc";
export function normalizeCompanyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return base.replace(new RegExp(`( (${LEGAL_SUFFIX_TOKENS}))+$`), "");
}

export interface CompanyInput {
  name?: string | null;
  linkedin_company_id?: string | null;
  linkedin_url?: string | null;
  universal_name?: string | null;
  logo_url?: string | null;
}

// ── CAR-269: hardcoded company consolidations ──────────────────────────
//
// Acquisitions where LinkedIn keeps a separate company page for the acquired
// brand, so scraped identity alone can never unify them: Workfront kept page
// 48453 after Adobe bought it, Divvy kept 10593835 (universal_name
// "divvynowbill") after BILL bought it. Dawson's ruling: these ARE the parent
// company. Every resolution path funnels through this file (no other code
// writes `companies`), so rewriting the input here — before the match ladder
// runs — is sufficient to stop the duplicate rows from ever being minted
// again. The rows that already exist are merged by the companion migration
// (20260808..._car269_merge_workfront_and_divvy.sql).

interface CanonicalCompanyIdentity {
  name: string;
  linkedin_company_id: string;
  linkedin_url: string;
  universal_name: string;
}

const CANONICAL_ADOBE: CanonicalCompanyIdentity = {
  name: "Adobe",
  linkedin_company_id: "1480",
  linkedin_url: "https://www.linkedin.com/company/adobe",
  universal_name: "adobe",
};

const CANONICAL_BILL: CanonicalCompanyIdentity = {
  name: "BILL (Bill.com)",
  linkedin_company_id: "113254",
  linkedin_url: "https://www.linkedin.com/company/bill",
  universal_name: "bill",
};

const CONSOLIDATED_BY_LINKEDIN_ID: Record<string, CanonicalCompanyIdentity> = {
  "48453": CANONICAL_ADOBE, // Adobe Workfront's own page
  "10593835": CANONICAL_BILL, // Divvy's own page ("divvynowbill")
};

const CONSOLIDATED_BY_UNIVERSAL_NAME: Record<string, CanonicalCompanyIdentity> = {
  adobeworkfront: CANONICAL_ADOBE,
  divvynowbill: CANONICAL_BILL,
};

// Fires ONLY for name-only inputs (extension import, MCP add_contact, the
// contact forms). An input carrying any LinkedIn identity keeps it: a company
// that merely shares a word must never be captured by a name alias when its
// own identity can resolve it.
const CONSOLIDATED_BY_NORMALIZED_NAME: Record<string, CanonicalCompanyIdentity> = {
  workfront: CANONICAL_ADOBE,
  "adobe workfront": CANONICAL_ADOBE,
  "adobe workfront office": CANONICAL_ADOBE,
  divvy: CANONICAL_BILL,
  bill: CANONICAL_BILL,
  "bill com": CANONICAL_BILL,
};

function companyUrlSlug(url: string | null | undefined): string | null {
  const match = url?.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * Rewrite a consolidated-company input to its canonical identity. Returns the
 * SAME object when no consolidation applies (callers rely on identity
 * equality to detect a rewrite). Precedence mirrors findOrCreateCompany's
 * match ladder: a non-consolidated linkedin_company_id wins outright, then
 * universal_name / URL slug, then (name-only inputs) the normalized name.
 * logo_url is dropped on rewrite so an acquired brand's logo is never stamped
 * onto the parent row.
 */
export function applyCompanyConsolidations(input: CompanyInput): CompanyInput {
  const id = input.linkedin_company_id?.trim();
  let canonical: CanonicalCompanyIdentity | undefined;
  if (id) {
    canonical = CONSOLIDATED_BY_LINKEDIN_ID[id];
    if (!canonical) return input; // carries its own (non-consolidated) identity
  } else {
    const universal =
      input.universal_name?.trim().toLowerCase() || companyUrlSlug(input.linkedin_url);
    if (universal) canonical = CONSOLIDATED_BY_UNIVERSAL_NAME[universal];
    if (!canonical && isNameOnlyCompanyInput(input) && input.name) {
      canonical = CONSOLIDATED_BY_NORMALIZED_NAME[normalizeCompanyName(input.name)];
    }
  }
  if (!canonical) return input;
  return {
    name: canonical.name,
    linkedin_company_id: canonical.linkedin_company_id,
    linkedin_url: canonical.linkedin_url,
    universal_name: canonical.universal_name,
    logo_url: null,
  };
}

export interface CompanyRecord {
  id: number;
  name: string;
  linkedin_company_id: string | null;
  linkedin_url: string | null;
  universal_name: string | null;
  logo_url: string | null;
}

export interface CompanyResolveResult extends CompanyRecord {
  /** Set when an identity-less insert created a row whose name resembles an
   * existing company (parenthetical/slash token or name prefix). The row IS
   * created — this is a warning surface for imports, not a block (CAR-44). */
  possible_duplicate_of?: { id: number; name: string };
}

// NOTE: companies.domain was dropped in prod (20260709135000, CAR-6 branch) —
// selecting it 500s every company-resolution path. Do not re-add.
export const COMPANY_COLS = "id, name, linkedin_company_id, linkedin_url, universal_name, logo_url";

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

  // CAR-269: sweep with canonical identities, but remember each rewritten
  // input's caller-visible key — callers compute lookup keys from their RAW
  // inputs, so a hit must be registered under both keys or every aliased
  // company silently degrades to a findOrCreateCompany round trip.
  const rawInputs = inputs;
  inputs = inputs.map(applyCompanyConsolidations);
  const aliasIdKeys = new Map<string, string>(); // raw linkedin id -> canonical linkedin id
  const aliasNameKeys = new Map<string, string>(); // raw name-only key -> canonical linkedin id
  rawInputs.forEach((raw, i) => {
    const canon = inputs[i];
    if (canon === raw) return;
    const rawId = raw.linkedin_company_id?.trim();
    if (rawId) {
      if (rawId !== canon.linkedin_company_id) aliasIdKeys.set(rawId, canon.linkedin_company_id!);
      return;
    }
    const nameKey = companyFallbackName(raw)?.toLowerCase();
    if (nameKey) aliasNameKeys.set(nameKey, canon.linkedin_company_id!);
  });

  const ids = [...new Set(inputs.map((i) => i.linkedin_company_id?.trim()).filter(Boolean))] as string[];
  for (const chunk of chunkList(ids)) {
    // error-tolerated: this is a warm-cache pass only; an id that misses the
    // map runs findOrCreateCompany's full chain, so a failed read costs a
    // round trip rather than resolving the company wrongly.
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
    // error-tolerated: same warm-cache contract as the id sweep above — a
    // name that misses falls through to the full resolve chain.
    const { data } = await supabase.from("companies").select(COMPANY_COLS).in("name", chunk);
    for (const row of (data as CompanyRecord[] | null) ?? []) {
      const key = row.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, row);
    }
  }

  // CAR-269: register consolidated hits under the raw keys callers use.
  for (const [rawId, canonId] of aliasIdKeys) {
    const row = byId.get(canonId);
    if (row && !byId.has(rawId)) byId.set(rawId, row);
  }
  for (const [nameKey, canonId] of aliasNameKeys) {
    const row = byId.get(canonId);
    if (row && !byName.has(nameKey)) byName.set(nameKey, row);
  }
  return { byId, byName };
}

export async function findOrCreateCompany(
  supabase: SupabaseClient,
  input: CompanyInput,
): Promise<CompanyResolveResult> {
  input = applyCompanyConsolidations(input);
  const companyId = input.linkedin_company_id?.trim() || null;
  const linkedinUrl = normalizeCompanyLinkedinUrl(input.linkedin_url);
  const universalName = normalizeUniversalName(input.universal_name);
  const name = companyFallbackName(input);
  if (!name && !companyId) throw new Error("findOrCreateCompany requires a name or linkedin_company_id");

  // 1. Stable-id match
  if (companyId) {
    const data = must(
      await supabase
        .from("companies")
        .select(COMPANY_COLS)
        .eq("linkedin_company_id", companyId)
        .maybeSingle(),
    );
    if (data) return data as CompanyRecord;
  }

  // 2. LinkedIn URL match
  if (linkedinUrl) {
    const byUrl = must(
      await supabase
        .from("companies")
        .select(COMPANY_COLS)
        .ilike("linkedin_url", escapeIlike(linkedinUrl))
        .limit(1),
    );
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
    const byUniversal = must(
      await supabase
        .from("companies")
        .select(COMPANY_COLS)
        .ilike("universal_name", escapeIlike(universalName))
        .limit(1),
    );
    const existing = (byUniversal as CompanyRecord[] | null)?.[0];
    if (existing) {
      if (companyId && !existing.linkedin_company_id) {
        return await claimCompanyRow(supabase, existing, input, companyId);
      }
      return existing;
    }
  }

  // 4. Name match — normalized equality (case/punctuation/legal-suffix
  //    insensitive) via companies.name_normalized, so "Rubrik" resolves to
  //    an existing "Rubrik, Inc." instead of minting a split row (CAR-44).
  //    Falls back to exact escaped ilike when the name normalizes away.
  //    limit(1) + id order: normalized variants could coexist.
  if (name) {
    const nameNorm = normalizeCompanyName(name);
    const byNameQuery = supabase.from("companies").select(COMPANY_COLS);
    const byName = must(
      nameNorm
        ? await byNameQuery.eq("name_normalized", nameNorm).order("id", { ascending: true }).limit(1)
        : await byNameQuery.ilike("name", escapeIlike(name)).limit(1),
    );
    const existing = (byName as CompanyRecord[] | null)?.[0];
    if (existing) {
      if (companyId && !existing.linkedin_company_id) {
        return await claimCompanyRow(supabase, existing, input, companyId);
      }
      return existing;
    }
  }

  // 5. Insert. Identity-less inserts (no id/url/universal_name) are how
  //    split company rows were minted (CAR-44) — probe for a similar-looking
  //    existing row first so the caller can surface a duplicate warning.
  const suspectedDuplicate =
    !companyId && !linkedinUrl && !universalName && name
      ? await probeSimilarCompany(supabase, name)
      : null;

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
  if (!error && created) {
    const record = created as CompanyResolveResult;
    if (suspectedDuplicate && suspectedDuplicate.id !== record.id) {
      console.warn(
        `[company-helpers] created identity-less company "${record.name}" (id ${record.id}) ` +
          `which may duplicate "${suspectedDuplicate.name}" (id ${suspectedDuplicate.id})`,
      );
      record.possible_duplicate_of = { id: suspectedDuplicate.id, name: suspectedDuplicate.name };
    }
    return record;
  }

  // Unique-violation race (name or linkedin_company_id): refetch. Every leg
  // below runs only after the insert already failed, purely to recover the
  // row a concurrent writer won; a failed refetch falls through to the
  // `throw error` at the end, surfacing the original insert failure.
  if (companyId) {
    // error-tolerated: post-insert-failure recovery read; falling through
    // rethrows the original insert error, which is the more diagnostic one.
    const { data: retryById } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("linkedin_company_id", companyId)
      .maybeSingle();
    if (retryById) return retryById as CompanyRecord;
  }
  if (linkedinUrl) {
    // error-tolerated: same post-insert-failure recovery contract as above.
    const { data: retryByUrl } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("linkedin_url", escapeIlike(linkedinUrl))
      .limit(1);
    const retriedByUrl = (retryByUrl as CompanyRecord[] | null)?.[0];
    if (retriedByUrl) return retriedByUrl as CompanyRecord;
  }
  if (universalName) {
    // error-tolerated: same post-insert-failure recovery contract as above.
    const { data: retryByUniversal } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .ilike("universal_name", escapeIlike(universalName))
      .limit(1);
    const retriedByUniversal = (retryByUniversal as CompanyRecord[] | null)?.[0];
    if (retriedByUniversal) return retriedByUniversal as CompanyRecord;
  }
  // error-tolerated: last post-insert-failure recovery leg; a failed read
  // lands on the `throw error` immediately below.
  const { data: retryByName } = await supabase
    .from("companies")
    .select(COMPANY_COLS)
    .ilike("name", escapeIlike(name!))
    .limit(1);
  const retried = (retryByName as CompanyRecord[] | null)?.[0];
  if (retried) return retried as CompanyRecord;
  throw error ?? new Error(`Failed to find or create company "${name}"`);
}

/**
 * Cheap similarity probe used only for identity-less creates: does the new
 * name look like an existing company? Checks (a) each parenthetical/slash
 * token — "Verifi (Visa)" ~ "Visa", "TikTok / ByteDance" ~ "ByteDance" —
 * and (b) the normalized name as a prefix of an existing normalized name —
 * "Zoom" ~ "Zoom Video Communications". Heuristic warn surface only; it
 * never blocks the insert or auto-merges.
 */
async function probeSimilarCompany(
  supabase: SupabaseClient,
  name: string,
): Promise<CompanyRecord | null> {
  const norm = normalizeCompanyName(name);
  if (!norm) return null;

  const tokens = new Set<string>();
  for (const segment of name.split("/")) {
    const parentheticals = [...segment.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
    const base = segment.replace(/\([^)]*\)/g, " ");
    for (const candidate of [base, ...parentheticals]) {
      const tokenNorm = normalizeCompanyName(candidate);
      if (tokenNorm && tokenNorm !== norm && tokenNorm.length >= 3) tokens.add(tokenNorm);
    }
  }
  if (tokens.size > 0) {
    // error-tolerated: this probe only decides whether to attach a
    // possible_duplicate_of warning; a failed read means no warning, never a
    // blocked insert or a wrong merge.
    const { data } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .in("name_normalized", [...tokens])
      .order("id", { ascending: true })
      .limit(1);
    const hit = (data as CompanyRecord[] | null)?.[0];
    if (hit) return hit;
  }

  // Prefix probe: an existing longer name starting with this one. Length
  // floor keeps ultra-short names ("X") from matching half the table.
  if (norm.length >= 4) {
    // error-tolerated: same warn-only surface as the token probe above.
    const { data } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .like("name_normalized", `${escapeIlike(norm)} %`)
      .order("id", { ascending: true })
      .limit(1);
    const hit = (data as CompanyRecord[] | null)?.[0];
    if (hit) return hit;
  }
  return null;
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

  // Compare-and-set: `patch` WRITES linkedin_company_id while the filter below
  // re-tests it, so success is reported by row COUNT (rule 17, CAR-158). Read
  // back through .select() and a won claim can answer "zero rows" — because the
  // updated row no longer satisfies .is("linkedin_company_id", null) — which
  // this function would then misread as a lost race and resolve through the
  // owner lookup instead.
  const { count, error } = await supabase
    .from("companies")
    .update(patch, { count: "exact" })
    .eq("id", existing.id)
    .is("linkedin_company_id", null); // claim only if still unclaimed (race guard)

  if (!error && (count ?? 0) > 0) {
    // Claim won. Re-read by primary key only: filtering on the written column
    // here would reintroduce the same trap.
    // error-tolerated: a failed re-read falls through to the owner lookup and
    // then to `existing`, which is the same answer this path would give anyway.
    const { data: claimed } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("id", existing.id)
      .maybeSingle();
    if (claimed) return claimed as CompanyRecord;
  }

  // Claim lost a race (someone else claimed this or another row got the id),
  // or the unique index rejected a duplicate id — fall back to the id owner.
  {
    // error-tolerated: the claim already lost its race, and `existing` below
    // is the defined fallback. A failed owner lookup lands on that same
    // fallback, so tolerating it changes nothing about the outcome.
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
    // error-tolerated: warm-cache pass only; a city that misses the map falls
    // back to findOrCreateLocation, so a failed read costs a round trip
    // rather than minting a duplicate location.
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
 * Thin delegate to the canonical implementation in src/lib/data/locations.ts
 * (CAR-155), which also normalizes internally — already-normalized inputs
 * from the import/bulk pipelines pass through unchanged (idempotent).
 *
 * This wrapper is the SCRAPE/IMPORT seam (import route, backfill, bulk
 * import, bundle publish/resolve) and pins source "scraped" — full metro
 * collapsing applies. User-provenance writers (forms, MCP, manual work
 * locations) call the canonical function directly with source "user"
 * (CAR-173).
 */
export async function findOrCreateLocation(
  supabase: SupabaseClient,
  location: LocationInput,
): Promise<{ id: number }> {
  const row = await findOrCreateLocationShared(location, { client: supabase as unknown as QueryClient, source: "scraped" });
  if (!row) throw new Error("findOrCreateLocation: input normalized to no location");
  return { id: row.id };
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

/**
 * Target the companies a deliberately-added person CURRENTLY works at (CAR-263).
 *
 * Adding someone by hand is a statement that you care about where they work, so
 * their employer joins the target list instead of sitting in the `in_play` limbo
 * every imported contact's employer occupies. Measured against real data before
 * scoping this: applying it to EVERY contact would have created 528 targets at
 * once, so the bulk paths (bundle sync, pipeline import, scrape refresh) do not
 * call this. Only the five deliberate single-person paths do.
 *
 * Three rules, each load-bearing:
 *
 * 1. **CURRENT roles only.** A profile save mints a company row for every job in
 *    the person's history, so passing "their companies" unfiltered would target
 *    all fifteen past employers. Callers pass only what `is_current` covers.
 * 2. **Missing rows only — `is_targeted` is never written.** A company the user
 *    untargeted must stay untargeted when another contact there shows up. This is
 *    CAR-258's rule at a second call site: nothing automatic may reverse a
 *    hand-set un-target.
 * 3. **Company-wide scope only** (`location_id IS NULL`). Office-level targeting
 *    is a deliberate per-office act on the company page, not something a contact
 *    save can infer.
 *
 * Returns how many targets were created. Never throws for the caller's sake: a
 * contact save must not fail because the target bookkeeping did, so errors are
 * logged and swallowed — including the 23505 a concurrent save races into
 * against `target_companies_user_company_companywide`, where losing the race
 * means the row exists, which is the goal.
 */
export async function ensureCompanyTargets(
  supabase: SupabaseClient,
  userId: string,
  companyIds: number[],
): Promise<number> {
  const ids = [...new Set(companyIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return 0;

  try {
    // Chunked because a single contact can carry more employers than a URL-length
    // `in()` safely holds, and this shares the data layer's limits.
    const have = new Set<number>();
    for (const chunk of chunkList(ids)) {
      const rows = must(
        await supabase
          .from("target_companies")
          .select("company_id")
          .eq("user_id", userId)
          .is("location_id", null)
          .in("company_id", chunk)
          // Deliberate and exactly sufficient: `target_companies_user_company_companywide`
          // is UNIQUE on (user_id, company_id) WHERE location_id IS NULL, so this
          // returns at most one row per id in the chunk. Never near PostgREST's
          // silent 1000-row truncation, and a partial page here would read as
          // "not targeted yet" and create a duplicate.
          .limit(chunk.length),
      ) as Array<{ company_id: number }> | null;
      for (const r of rows ?? []) have.add(r.company_id);
    }

    const missing = ids.filter((id) => !have.has(id));
    if (missing.length === 0) return 0;

    // `is_targeted` and `status` are omitted so both take their column defaults
    // (true / 'researching') — the same shape addTargetCompany inserts.
    const { error } = await supabase
      .from("target_companies")
      .insert(missing.map((company_id) => ({ user_id: userId, company_id })));
    if (error) {
      // 23505 = another save created the same row first. Not a failure.
      if ((error as { code?: string }).code !== "23505") throw error;
      return 0;
    }
    return missing.length;
  } catch (err) {
    console.error("[ensureCompanyTargets] could not target current employers:", err);
    return 0;
  }
}

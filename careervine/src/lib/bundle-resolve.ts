/**
 * Publish-time bundle entity resolution (CAR-62).
 *
 * A bundle's prospects reference global entities — companies, locations,
 * schools — that used to be re-resolved by every subscriber's every sync
 * chunk (the find-or-create chains were 50–100s of every sync). This module
 * resolves them ONCE per published version, on the service client, and
 * stores the outcome on each bundle_prospects row (`resolved` jsonb,
 * positionally aligned with the payload arrays). Subscriber syncs then
 * consume the ids verbatim: the merge path skips its resolution chains, and
 * blank subscribers take the bulk fast path (bundle-fast-apply.ts).
 *
 * Office semantics deliberately mirror importPeopleChunk's two passes —
 * executed once, bundle-wide, instead of per subscriber chunk:
 *   pass 1: city-grain experience locations establish company_locations;
 *   pass 2: a current role without its own location claims an office
 *           matching the person's profile location (never for remote roles).
 *
 * Staleness is keyed on payload_hash: a republished prospect whose payload
 * changed gets re-resolved; hash-current rows are skipped, so re-running the
 * resolver is cheap and idempotent. data_bundles.resolved_version advances
 * to the committed version only when a full pass leaves every live row
 * hash-current — that column gates the fast path, so an interrupted resolve
 * degrades to the merge path, never to wrong data.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseBundleProspectPayload, payloadToMappedPerson } from "./bundle-payload";
import {
  findOrCreateCompany,
  findOrCreateLocation,
  ensureCompanyLocations,
  prefetchCompanies,
  prefetchLocations,
  locationLookupKey,
  companyFallbackName,
  isNameOnlyCompanyInput,
  chunkList,
  type CompanyInput,
  type CompanyRecord,
} from "./company-helpers";
import {
  normalizeLocation,
  normalizeParsedLocation,
  locationMatchKey,
  type NormalizedLocation,
} from "./location-normalizer";
import { findOrCreateSchool } from "./bulk-import";

export const RESOLVE_CHUNK_SIZE = 200;

// ── Snapshot shape ─────────────────────────────────────────────────────

export interface ResolvedExperience {
  company_id: number;
  location_id: number | null;
  location_source: string | null;
}

export interface ResolvedEducation {
  /** null = school name unresolvable (empty after trim / create failed). */
  school_id: number | null;
}

export interface BundleProspectResolution {
  /** Hash of the payload this resolution was computed from — mismatch = stale. */
  payload_hash: string;
  profile_location_id: number | null;
  /** Positionally aligned with payload.experiences. */
  experiences: ResolvedExperience[];
  /** Positionally aligned with payload.education. */
  education: ResolvedEducation[];
}

/** Parse a stored resolution; null when absent, malformed, or stale
 * (payload_hash mismatch). Readers must treat null as "resolve live". */
export function readProspectResolution(
  raw: unknown,
  payloadHash: string,
): BundleProspectResolution | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BundleProspectResolution>;
  if (r.payload_hash !== payloadHash) return null;
  if (!Array.isArray(r.experiences) || !Array.isArray(r.education)) return null;
  for (const e of r.experiences) {
    if (!e || typeof (e as ResolvedExperience).company_id !== "number") return null;
  }
  return {
    payload_hash: r.payload_hash,
    profile_location_id: typeof r.profile_location_id === "number" ? r.profile_location_id : null,
    experiences: r.experiences as ResolvedExperience[],
    education: r.education as ResolvedEducation[],
  };
}

// ── Resolver ───────────────────────────────────────────────────────────

interface ResolveProspectRow {
  id: number;
  linkedin_url: string;
  payload: unknown;
  payload_schema_version: number;
  payload_hash: string;
  resolved: unknown;
}

export interface ResolveChunkResult {
  done: boolean;
  nextAfterId: number | null;
  scanned: number;
  resolved: number;
  skipped: string[];
}

/**
 * Resolve one cursor chunk of a bundle's live prospects on the SERVICE
 * client. Hash-current rows are skipped; the rest get companies, locations
 * (with office establishment), and schools resolved and written back through
 * the apply_bundle_resolutions RPC in one round trip.
 */
export async function resolveBundleChunk(
  service: SupabaseClient,
  bundle: { id: number; slug: string; version: number },
  opts: { afterId?: number; chunkSize?: number } = {},
): Promise<ResolveChunkResult> {
  const chunkSize = opts.chunkSize ?? RESOLVE_CHUNK_SIZE;
  const afterId = opts.afterId ?? 0;
  const result: ResolveChunkResult = { done: false, nextAfterId: null, scanned: 0, resolved: 0, skipped: [] };

  const { data: rows } = await service
    .from("bundle_prospects")
    .select("id, linkedin_url, payload, payload_schema_version, payload_hash, resolved")
    .eq("bundle_id", bundle.id)
    .is("removed_in_version", null)
    .gt("id", afterId)
    .order("id", { ascending: true })
    .limit(chunkSize);
  const prospects = (rows as ResolveProspectRow[] | null) ?? [];
  result.scanned = prospects.length;

  // Parse the stale rows into mapped persons (1:1 with payload arrays).
  const pending: Array<{ row: ResolveProspectRow; mapped: ReturnType<typeof payloadToMappedPerson> }> = [];
  for (const row of prospects) {
    if (readProspectResolution(row.resolved, row.payload_hash)) continue; // hash-current
    const parsed = parseBundleProspectPayload(row.payload, row.payload_schema_version);
    if (!parsed.ok) {
      result.skipped.push(`${row.linkedin_url}: ${parsed.reason}`);
      continue;
    }
    pending.push({
      row,
      mapped: payloadToMappedPerson(parsed.payload, {
        bundleId: bundle.id,
        bundleSlug: bundle.slug,
        bundleVersion: bundle.version,
      }),
    });
  }

  if (pending.length > 0) {
    // ── Companies: bulk prefetch, find-or-create chain on misses ──
    const companyInputs: CompanyInput[] = pending.flatMap((p) =>
      p.mapped.employment.map((emp) => ({
        name: emp.company_name,
        linkedin_company_id: emp.linkedin_company_id,
        linkedin_url: emp.company_linkedin_url,
        universal_name: emp.company_universal_name,
      })),
    );
    const companyPrefetch = await prefetchCompanies(service, companyInputs);
    const companyCache = new Map<string, CompanyRecord>();
    const resolveCompany = async (input: CompanyInput): Promise<CompanyRecord> => {
      const idKey = input.linkedin_company_id?.trim();
      const cacheKey = idKey ? `id:${idKey}` : `name:${(companyFallbackName(input) ?? "").toLowerCase()}`;
      const cached = companyCache.get(cacheKey);
      if (cached) return cached;
      const nameKey = isNameOnlyCompanyInput(input) ? companyFallbackName(input)?.toLowerCase() : undefined;
      const company =
        (idKey ? companyPrefetch.byId.get(idKey) : nameKey ? companyPrefetch.byName.get(nameKey) : undefined) ??
        (await findOrCreateCompany(service, input));
      companyCache.set(cacheKey, company);
      return company;
    };

    // ── Locations: bulk prefetch, find-or-create on misses ──
    const locationInputs: Array<{ city: string | null; state: string | null; country: string }> = [];
    const collectLocationInput = (norm: NormalizedLocation | null | undefined) => {
      if (!norm || !locationMatchKey(norm)) return;
      locationInputs.push({ city: norm.city, state: norm.state, country: norm.country ?? "United States" });
    };
    const profileNormOf = (mapped: (typeof pending)[number]["mapped"]) =>
      mapped.profile_location
        ? normalizeParsedLocation(mapped.profile_location)
        : normalizeLocation(mapped.profile_location_raw);
    for (const p of pending) {
      for (const emp of p.mapped.employment) {
        const norm = emp.location_raw ? normalizeLocation(emp.location_raw) : null;
        if (norm && norm.canEstablishOffice && !norm.isRemote && emp.workplace_type !== "remote") {
          collectLocationInput(norm);
        }
      }
      collectLocationInput(profileNormOf(p.mapped));
    }
    const locationPrefetch = await prefetchLocations(service, locationInputs);
    const locationIdCache = new Map<string, number>();
    const resolveLocationId = async (norm: NormalizedLocation): Promise<number> => {
      const key = locationMatchKey(norm)!;
      const cached = locationIdCache.get(key);
      if (cached != null) return cached;
      const input = { city: norm.city, state: norm.state, country: norm.country ?? "United States" };
      const found = locationPrefetch.get(locationLookupKey(input)) ?? (await findOrCreateLocation(service, input));
      locationIdCache.set(key, found.id);
      return found.id;
    };

    // ── Schools: exact-name sweep, find-or-create on misses ──
    const schoolCache = new Map<string, { id: number } | null>();
    const schoolNames = [
      ...new Set(pending.flatMap((p) => p.mapped.education.map((e) => e.school_name.trim()).filter(Boolean))),
    ];
    for (const nameChunk of chunkList(schoolNames)) {
      const { data } = await service.from("schools").select("id, name").in("name", nameChunk);
      for (const row of (data as Array<{ id: number; name: string }> | null) ?? []) {
        const key = row.name.toLowerCase();
        if (!schoolCache.has(key)) schoolCache.set(key, { id: row.id });
      }
    }
    const resolveSchoolId = async (name: string): Promise<number | null> => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const key = trimmed.toLowerCase();
      const cached = schoolCache.get(key);
      if (cached !== undefined) return cached?.id ?? null;
      const school = await findOrCreateSchool(service, trimmed);
      schoolCache.set(key, school);
      return school?.id ?? null;
    };

    // ── Pass 1: experience locations resolve + establish offices ──
    type WorkingExp = {
      companyId: number;
      locationId: number | null;
      locationSource: string | null;
      isRemote: boolean;
      isCurrent: boolean;
    };
    const workingByProspect: WorkingExp[][] = [];
    const chunkOffices = new Map<number, Map<string, number>>(); // company → matchKey → location
    const newOfficePairs: Array<{ company_id: number; location_id: number }> = [];
    for (const p of pending) {
      const exps: WorkingExp[] = [];
      for (const emp of p.mapped.employment) {
        const company = await resolveCompany({
          name: emp.company_name,
          linkedin_company_id: emp.linkedin_company_id,
          linkedin_url: emp.company_linkedin_url,
          universal_name: emp.company_universal_name,
        });
        const norm = emp.location_raw ? normalizeLocation(emp.location_raw) : null;
        const isRemote = emp.workplace_type === "remote" || Boolean(norm?.isRemote);
        let locationId: number | null = null;
        let locationSource: string | null = null;
        if (norm && norm.canEstablishOffice && !isRemote) {
          locationId = await resolveLocationId(norm);
          locationSource = "experience";
          const key = locationMatchKey(norm)!;
          let offices = chunkOffices.get(company.id);
          if (!offices) {
            offices = new Map();
            chunkOffices.set(company.id, offices);
          }
          if (!offices.has(key)) {
            offices.set(key, locationId);
            newOfficePairs.push({ company_id: company.id, location_id: locationId });
          }
        }
        exps.push({ companyId: company.id, locationId, locationSource, isRemote, isCurrent: emp.is_current });
      }
      workingByProspect.push(exps);
    }
    await ensureCompanyLocations(service, newOfficePairs, "scraped");

    // Load already-known offices for every company touched, so pass 2 sees
    // DB state + this run's establishments.
    const companyIds = [...new Set(workingByProspect.flat().map((e) => e.companyId))];
    for (const idChunk of chunkList(companyIds)) {
      const { data: officeRows } = await service
        .from("company_locations")
        .select("company_id, location_id, locations(city, state, country)")
        .in("company_id", idChunk);
      for (const row of (officeRows as Array<{
        company_id: number;
        location_id: number;
        locations: { city: string | null; state: string | null; country: string } | null;
      }> | null) ?? []) {
        if (!row.locations) continue;
        const key = locationMatchKey(normalizeParsedLocation(row.locations));
        if (!key) continue;
        let offices = chunkOffices.get(row.company_id);
        if (!offices) {
          offices = new Map();
          chunkOffices.set(row.company_id, offices);
        }
        if (!offices.has(key)) offices.set(key, row.location_id);
      }
    }

    // ── Pass 2 + profile location + schools → build resolutions ──
    const rpcRows: Array<{ id: number; resolved: BundleProspectResolution }> = [];
    for (let pi = 0; pi < pending.length; pi++) {
      const p = pending[pi];
      const exps = workingByProspect[pi];
      const profileNorm = profileNormOf(p.mapped);
      const profileKey = locationMatchKey(profileNorm);
      for (const exp of exps) {
        if (!exp.isCurrent || exp.locationId != null || exp.isRemote || !profileKey) continue;
        const officeLocation = chunkOffices.get(exp.companyId)?.get(profileKey);
        if (officeLocation != null) {
          exp.locationId = officeLocation;
          exp.locationSource = "profile_match";
        }
      }

      const profileLocationId = profileKey ? await resolveLocationId(profileNorm) : null;
      const education: ResolvedEducation[] = [];
      for (const edu of p.mapped.education) {
        education.push({ school_id: await resolveSchoolId(edu.school_name) });
      }

      rpcRows.push({
        id: p.row.id,
        resolved: {
          payload_hash: p.row.payload_hash,
          profile_location_id: profileLocationId,
          experiences: exps.map((e) => ({
            company_id: e.companyId,
            location_id: e.locationId,
            location_source: e.locationSource,
          })),
          education,
        },
      });
    }

    if (rpcRows.length > 0) {
      const { error } = await service.rpc("apply_bundle_resolutions", {
        p_rows: rpcRows,
      });
      if (error) throw new Error(`apply_bundle_resolutions failed: ${error.message}`);
      result.resolved = rpcRows.length;
    }
  }

  if (prospects.length === chunkSize) {
    result.nextAfterId = prospects[prospects.length - 1].id;
    return result;
  }
  result.done = true;
  return result;
}

/**
 * Stamp data_bundles.resolved_version after a resolve loop walked every live
 * row to exhaustion. Guarded on the version the loop ran against: a publish
 * committed mid-loop bumps version, the eq() misses, and the new version
 * simply stays unresolved until its own resolve pass.
 */
export async function markBundleResolved(
  service: SupabaseClient,
  bundle: { id: number; version: number },
): Promise<void> {
  await service
    .from("data_bundles")
    .update({ resolved_version: bundle.version, updated_at: new Date().toISOString() })
    .eq("id", bundle.id)
    .eq("version", bundle.version);
}

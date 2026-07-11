/**
 * Bulk-import orchestration for pipeline people-records (plan 24 §2f).
 *
 * One chunk (≤50 people) per call — the pipeline's load script chunks to
 * stay inside Vercel wall-clock limits. Within a chunk the employment-
 * location inference rule runs in two passes:
 *
 *   Pass 1 (rule 1): experience entries with their own city-grain location
 *   establish company_locations offices.
 *   Pass 2 (rule 2): CURRENT roles without an experience location claim a
 *   location only when the person's profile location matches an office
 *   already known for that company (DB + this chunk). Matching is
 *   string-level via locationMatchKey — legacy location rows predate the
 *   normalizer, so raw id equality would silently miss.
 *   Rule 3: otherwise no employment location; no office invented.
 *
 * Remote roles (workplaceType or a "remote" location marker) never
 * establish or claim offices. Cross-chunk ordering effects are mopped up
 * by the rule-2 backfill endpoint, which the load script calls once at
 * the end.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapPeopleRecord,
  ScrapeMappingError,
  type MappedPerson,
  type PeopleRecord,
} from "./scrape-mapper";
import {
  normalizeLocation,
  normalizeParsedLocation,
  locationMatchKey,
  type NormalizedLocation,
} from "./location-normalizer";
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
  escapeIlike,
  COMPANY_COLS,
  type CompanyInput,
  type CompanyRecord,
} from "./company-helpers";
import {
  computeEmploymentMerge,
  computeEmailMerge,
  computeContactPatch,
  type ExistingEmploymentRow,
  type IncomingEmploymentRow,
  type MergePolicy,
} from "./scrape-merge";
import { addTagsToContacts, downloadAndStorePhoto, isValidImportEmail } from "./import-db-helpers";
import { trackServer, checkContactMilestone } from "@/lib/analytics/server";
import type { AnalyticsEvents } from "@/lib/analytics/events";
import { isBundlePhotoUrl, bundlePhotoOverwriteAllowed } from "./photo-urls";

// ── Input / output shapes ──────────────────────────────────────────────

export interface TrackerState {
  stage?: string | null;
  last_touch?: string | null;
  next_action?: string | null;
  next_action_date?: string | null;
  notes?: string | null;
}

export interface PersonImportInput {
  /** Raw pipeline record — mapped internally via mapPeopleRecord. */
  record?: PeopleRecord;
  /** Pre-mapped person (bundle syncs map payloads themselves). Wins over record. */
  mapped?: MappedPerson;
  tracker?: TrackerState | null;
}

export interface PersonImportResult {
  linkedin_url: string | null;
  name: string | null;
  status: "created" | "updated" | "skipped_suppressed" | "error";
  /** Contact row the person landed in (created or merged into). */
  contact_id?: number;
  network_status?: string;
  warnings: string[];
  persona_conflict?: { existing: string; incoming: string };
  employment?: { inserted: number; updated: number; deleted: number };
  /** Contact-table patch applied on the update path — lets bundle sync
   * compute post-apply fingerprints from the pre-snapshot without a
   * TOCTOU-prone re-read. */
  applied_patch?: Record<string, unknown>;
  photo?: "stored" | "skipped" | "none";
  error?: string;
}

export interface ChunkImportSummary {
  results: PersonImportResult[];
  offices_established: number;
}

export interface ImportChunkOptions {
  /** Import batch label appended to import_source (pipeline policy only). */
  batch?: string;
  /** 'pipeline' (default, original behavior), 'bundle' (strict fill-empty,
   * create-only provenance, additive employment, no photo phase), or
   * 'rescrape' (CAR-15 in-app re-scrape: observed-data-only patch, manual
   * roles protected via the 'reconcile' collision strategy, suppression
   * skipped, never creates contacts). */
  mergePolicy?: MergePolicy;
  /** First line of the notes field on newly created contacts. */
  noteLabel?: string;
  /** Skip the best-effort photo phase entirely. */
  skipPhotos?: boolean;
  /**
   * When set, the chunk emits contact_imported {source, count} + the
   * contacts_5 milestone check for contacts it ACTUALLY created (CAR-58 —
   * dedupes/updates don't count, and every import surface shares this emit
   * instead of each route rolling its own). Omit for rescrapes/refreshes,
   * which never represent a user importing contacts.
   */
  analyticsSource?: AnalyticsEvents["contact_imported"]["source"];
  /** Hand the analyticsSource emit + milestone check off instead of awaiting
   * them inline — the bundle apply route wires this to the api-handler's
   * post-response flush so analytics stay off the sync path (CAR-78). */
  deferAnalytics?: (p: Promise<unknown>) => void;
  /** Rescrape-only hooks (e.g. the scrape-diff capture). */
  hooks?: ImportHooks;
  /**
   * Single-record rescrapes only: the contact this run targets. Used as the
   * existing-contact match when URL/public-identifier lookup misses — a
   * contact stored under an internal member-id URL (discovery add, resolver
   * link) scrapes back with its vanity URL, which would otherwise read as
   * "Contact not found for rescrape" forever (plan 41).
   */
  targetContactId?: number;
}

/**
 * Pre-merge capture for the scrape-diff engine (plan 29 §5): the contact's
 * employment rows as they existed BEFORE this import, plus the incoming rows
 * with their resolved companies. The ingest layer feeds this to computeDiff —
 * the diff must see the pre-merge state, and company resolution only happens
 * inside this module.
 */
export interface RescrapeDiffCapture {
  contactId: number;
  contactName: string;
  linkedinUrl: string; // canonical — correlates back to the raw actor item
  existingEmployment: Array<{ company_id: number; title: string | null; start_month: string | null; is_current: boolean }>;
  incomingEmployment: Array<{
    company_id: number;
    linkedin_company_id: string | null;
    company_name: string | null;
    title: string | null;
    start_month: string | null;
    is_current: boolean;
  }>;
}

export interface ImportHooks {
  onDiffCapture?: (capture: RescrapeDiffCapture) => void;
}

/** Wall-clock budget for best-effort photo downloads per request. */
const PHOTO_BUDGET_MS = 12_000;

// ── Internal per-person working state ──────────────────────────────────

interface WorkingEmployment {
  mappedIndex: number;
  company: CompanyRecord;
  incoming: IncomingEmploymentRow;
  isRemote: boolean;
  locationNorm: NormalizedLocation | null;
  /** Location decision came from the publish-time snapshot (CAR-62) —
   * passes 1–2 must not establish offices or claim one for this row. */
  resolvedLocation?: boolean;
}

/** Chunk-level write sinks (CAR-47): per-person handlers collect email /
 * education / tag rows here; importPeopleChunk flushes them in bulk before
 * the photo phase. resolveSchool wraps the chunk's school cache. */
interface ChunkSinks {
  emails: Array<Record<string, unknown>>;
  education: Array<Record<string, unknown>>;
  /** contactId-prefixed education keys already sunk this chunk — two chunk
   * entries resolving to one contact can't see each other's unflushed rows,
   * and the DB unique index doesn't catch NULL start_year duplicates. */
  educationKeys: Set<string>;
  tags: Map<number, string[]>;
  resolveSchool: (name: string) => Promise<{ id: number } | null>;
}

interface WorkingPerson {
  input: PersonImportInput;
  mapped: MappedPerson;
  employment: WorkingEmployment[];
  result: PersonImportResult;
  contactId?: number;
  created?: boolean;
  /** The matched contact's photo before this import — rescrapes never replace it. */
  existingPhotoUrl?: string | null;
}

const CONTACT_CORE_COLUMNS =
  "id, name, linkedin_url, public_identifier, persona, network_status, location_id, headline, photo_url";

interface ContactCoreRow {
  id: number;
  name: string;
  linkedin_url: string | null;
  public_identifier: string | null;
  persona: string | null;
  network_status: string;
  location_id: number | null;
  headline: string | null;
  photo_url: string | null;
}

/** A new contact awaiting the chunk's bulk insert (CAR-57). */
interface PendingCreate {
  w: WorkingPerson;
  row: Record<string, unknown>;
  profileLocationId: number | null;
}

// ── Main entry ─────────────────────────────────────────────────────────

export async function importPeopleChunk(
  supabase: SupabaseClient,
  userId: string,
  people: PersonImportInput[],
  batchOrOpts?: string | ImportChunkOptions,
): Promise<ChunkImportSummary> {
  const opts: ImportChunkOptions =
    typeof batchOrOpts === "string" ? { batch: batchOrOpts } : (batchOrOpts ?? {});
  const policy: MergePolicy = opts.mergePolicy ?? "pipeline";
  const now = new Date().toISOString();
  const results: PersonImportResult[] = [];
  const working: WorkingPerson[] = [];

  // ── Map every record; contract violations become per-record errors ──
  for (const input of people) {
    try {
      if (!input.mapped && !input.record) {
        throw new ScrapeMappingError("Input has neither a record nor a pre-mapped person");
      }
      const mapped = input.mapped ?? mapPeopleRecord(input.record!, { batch: opts.batch });
      working.push({
        input,
        mapped,
        employment: [],
        result: {
          linkedin_url: mapped.linkedin_url,
          name: mapped.name,
          status: "created", // provisional
          warnings: [...mapped.warnings],
        },
      });
    } catch (err) {
      results.push({
        linkedin_url: input.mapped?.linkedin_url ?? input.record?.identity?.linkedin_url ?? null,
        name: input.mapped?.name ?? input.record?.identity?.name ?? null,
        status: "error",
        warnings: [],
        error: err instanceof ScrapeMappingError ? err.message : "Failed to map record",
      });
    }
  }

  if (working.length === 0) return { results, offices_established: 0 };

  // ── Suppression tombstones ──
  // Tombstones stop NEW imports of deleted contacts. A rescrape only refreshes
  // contacts that already exist, so suppression does not apply (and would
  // wrongly skip a contact whose URL was previously tombstoned).
  const urls = working.map((w) => w.mapped.linkedin_url);
  const suppressed = new Set<string>();
  if (policy !== "rescrape") {
    // chunkList bounds the .in() list — 150+ URL-encoded LinkedIn URLs in
    // one GET query string flirts with infra header limits (CAR-57).
    for (const urlChunk of chunkList(urls)) {
      const { data: suppressedRows } = await supabase
        .from("suppressed_imports")
        .select("linkedin_url")
        .eq("user_id", userId)
        .in("linkedin_url", urlChunk);
      for (const r of (suppressedRows as { linkedin_url: string }[] | null) ?? []) {
        suppressed.add(r.linkedin_url);
      }
    }
  }

  // ── Resolve companies once per chunk ──
  // Chunk-level prefetch (CAR-47): the exact-match lookups (stable id,
  // exact name) resolve in a handful of .in() queries; only misses pay the
  // per-company find-or-create chain. Employment rows carrying a publish-time
  // resolution (CAR-62) skip the chain entirely: their CompanyRecords come
  // from one bulk fetch by id, and their location decision is used verbatim.
  const resolvedCompanyIds = new Set<number>();
  const companyInputs: CompanyInput[] = [];
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    for (const emp of w.mapped.employment) {
      if (emp.resolved_company_id != null) {
        resolvedCompanyIds.add(emp.resolved_company_id);
        continue;
      }
      companyInputs.push({
        name: emp.company_name,
        linkedin_company_id: emp.linkedin_company_id,
        linkedin_url: emp.company_linkedin_url,
        universal_name: emp.company_universal_name,
      });
    }
  }
  const resolvedCompanies = new Map<number, CompanyRecord>();
  for (const idChunk of chunkList([...resolvedCompanyIds])) {
    const { data } = await supabase.from("companies").select(COMPANY_COLS).in("id", idChunk);
    for (const row of (data as CompanyRecord[] | null) ?? []) resolvedCompanies.set(row.id, row);
  }
  const companyPrefetch = await prefetchCompanies(supabase, companyInputs);

  const companyCache = new Map<string, CompanyRecord>();
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    for (let i = 0; i < w.mapped.employment.length; i++) {
      const emp = w.mapped.employment[i];

      // Publish-time resolution short-circuit: company and location decision
      // are snapshot values; passes 1–2 below skip these rows (offices were
      // established at publish). A resolved id whose company row has since
      // vanished (merge/delete) falls through to the normal chain.
      const resolvedCompany =
        emp.resolved_company_id != null ? resolvedCompanies.get(emp.resolved_company_id) : undefined;
      if (resolvedCompany) {
        // Same remote normalization as the unresolved branch below — the
        // snapshot stores the location decision, not the workplace flag.
        const isRemote =
          emp.workplace_type === "remote" ||
          Boolean((emp.location_raw ? normalizeLocation(emp.location_raw) : null)?.isRemote);
        w.employment.push({
          mappedIndex: i,
          company: resolvedCompany,
          isRemote,
          locationNorm: null,
          resolvedLocation: true,
          incoming: {
            company_id: resolvedCompany.id,
            title: emp.title,
            start_month: emp.start_month,
            end_month: emp.end_month,
            is_current: emp.is_current,
            location_id: emp.resolved_location_id ?? null,
            location_source: emp.resolved_location_id != null ? (emp.resolved_location_source ?? null) : null,
            location_raw: emp.location_raw,
            workplace_type: isRemote ? "remote" : emp.workplace_type,
            employment_type: emp.employment_type,
          },
        });
        continue;
      }

      const cacheKey = emp.linkedin_company_id
        ? `id:${emp.linkedin_company_id}`
        : `name:${(emp.company_name ?? "").trim().toLowerCase()}`;
      let company = companyCache.get(cacheKey);
      if (!company) {
        const input: CompanyInput = {
          name: emp.company_name,
          linkedin_company_id: emp.linkedin_company_id,
          linkedin_url: emp.company_linkedin_url,
          universal_name: emp.company_universal_name,
        };
        const idKey = input.linkedin_company_id?.trim();
        // Exact-name short-circuit ONLY for name-only inputs: when the input
        // also carries a url/universal_name, findOrCreateCompany's higher-
        // priority matchers must get first crack (CAR-47 audit).
        const nameKey = isNameOnlyCompanyInput(input) ? companyFallbackName(input)?.toLowerCase() : undefined;
        company =
          (idKey ? companyPrefetch.byId.get(idKey) : nameKey ? companyPrefetch.byName.get(nameKey) : undefined) ??
          (await findOrCreateCompany(supabase, input));
        companyCache.set(cacheKey, company);
      }

      const locationNorm = emp.location_raw ? normalizeLocation(emp.location_raw) : null;
      const isRemote = emp.workplace_type === "remote" || Boolean(locationNorm?.isRemote);
      w.employment.push({
        mappedIndex: i,
        company,
        isRemote,
        locationNorm,
        incoming: {
          company_id: company.id,
          title: emp.title,
          start_month: emp.start_month,
          end_month: emp.end_month,
          is_current: emp.is_current,
          location_id: null,
          location_source: null,
          location_raw: emp.location_raw,
          workplace_type: isRemote ? "remote" : emp.workplace_type,
          employment_type: emp.employment_type,
        },
      });
    }
  }

  // ── Pass 1 (rule 1): experience locations establish offices ──
  // Location prefetch (CAR-47): every location this module resolves is
  // city-grain (locationMatchKey gates it), so one city-keyed sweep covers
  // pass 1 AND the profile-location resolution in the persistence pass.
  const locationInputs: Array<{ city: string | null; state: string | null; country: string }> = [];
  const collectLocationInput = (norm: NormalizedLocation | null | undefined) => {
    if (!norm || !locationMatchKey(norm)) return;
    locationInputs.push({ city: norm.city, state: norm.state, country: norm.country ?? "United States" });
  };
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    for (const emp of w.employment) {
      if (emp.locationNorm && emp.locationNorm.canEstablishOffice && !emp.isRemote) {
        collectLocationInput(emp.locationNorm);
      }
    }
    // A snapshot-resolved profile location needs no lookup (CAR-62).
    if (w.mapped.resolved_profile_location_id !== undefined) continue;
    collectLocationInput(
      w.mapped.profile_location
        ? normalizeParsedLocation(w.mapped.profile_location)
        : normalizeLocation(w.mapped.profile_location_raw),
    );
  }
  const locationPrefetch = await prefetchLocations(supabase, locationInputs);

  const locationIdCache = new Map<string, number>(); // matchKey → locations.id
  const chunkOffices = new Map<number, Map<string, number>>(); // company → key → location
  let officesEstablished = 0;

  async function resolveLocationId(norm: NormalizedLocation): Promise<number> {
    const key = locationMatchKey(norm)!;
    const cached = locationIdCache.get(key);
    if (cached != null) return cached;
    const input = { city: norm.city, state: norm.state, country: norm.country ?? "United States" };
    const found =
      locationPrefetch.get(locationLookupKey(input)) ?? (await findOrCreateLocation(supabase, input));
    locationIdCache.set(key, found.id);
    return found.id;
  }

  const newOfficePairs: Array<{ company_id: number; location_id: number }> = [];
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    for (const emp of w.employment) {
      const norm = emp.locationNorm;
      if (!norm || !norm.canEstablishOffice || emp.isRemote) continue;
      const locationId = await resolveLocationId(norm);
      emp.incoming.location_id = locationId;
      emp.incoming.location_source = "experience";
      const key = locationMatchKey(norm)!;
      let offices = chunkOffices.get(emp.company.id);
      if (!offices) {
        offices = new Map();
        chunkOffices.set(emp.company.id, offices);
      }
      if (!offices.has(key)) {
        offices.set(key, locationId);
        newOfficePairs.push({ company_id: emp.company.id, location_id: locationId });
        officesEstablished++;
      }
    }
  }
  // One bulk ignore-duplicates upsert instead of a round trip per office
  // (CAR-47) — the all-offices load below then sees these rows like any
  // pre-existing office.
  await ensureCompanyLocations(supabase, newOfficePairs, "scraped");

  // ── Load known offices for every company in the chunk ──
  const companyIds = [...new Set([...companyCache.values()].map((c) => c.id))];
  if (companyIds.length > 0) {
    const { data: officeRows } = await supabase
      .from("company_locations")
      .select("company_id, location_id, locations(city, state, country)")
      .in("company_id", companyIds);
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

  // ── Pass 2 (rule 2): profile location claims known offices, current roles only ──
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    const profile = w.mapped.profile_location
      ? normalizeParsedLocation(w.mapped.profile_location)
      : normalizeLocation(w.mapped.profile_location_raw);
    const profileKey = locationMatchKey(profile);
    if (!profileKey) continue;
    for (const emp of w.employment) {
      if (emp.resolvedLocation) continue; // snapshot decision is final (CAR-62)
      if (!emp.incoming.is_current || emp.incoming.location_id != null || emp.isRemote) continue;
      const officeLocation = chunkOffices.get(emp.company.id)?.get(profileKey);
      if (officeLocation != null) {
        emp.incoming.location_id = officeLocation;
        emp.incoming.location_source = "profile_match";
      }
    }
  }

  // ── Existing-contact lookup (canonical url, then public_identifier) ──
  // Both lookups are chunked for the same header-limit reason as the
  // suppression sweep (CAR-57).
  const urlMap = new Map<string, ContactCoreRow>();
  for (const urlChunk of chunkList(urls)) {
    const { data: byUrl } = await supabase
      .from("contacts")
      .select(CONTACT_CORE_COLUMNS)
      .eq("user_id", userId)
      .in("linkedin_url", urlChunk);
    for (const c of (byUrl as ContactCoreRow[] | null) ?? []) {
      if (c.linkedin_url) urlMap.set(c.linkedin_url, c);
    }
  }
  const pids = working.map((w) => w.mapped.public_identifier).filter(Boolean) as string[];
  const pidMap = new Map<string, ContactCoreRow>();
  for (const pidChunk of chunkList(pids)) {
    const { data: byPid } = await supabase
      .from("contacts")
      .select(CONTACT_CORE_COLUMNS)
      .eq("user_id", userId)
      .in("public_identifier", pidChunk);
    for (const c of (byPid as ContactCoreRow[] | null) ?? []) {
      if (c.public_identifier) pidMap.set(c.public_identifier, c);
    }
  }

  // Explicit target for single-record rescrapes (see ImportChunkOptions).
  let targetRow: ContactCoreRow | undefined;
  if (opts.targetContactId != null && working.length === 1) {
    const { data: byId } = await supabase
      .from("contacts")
      .select(CONTACT_CORE_COLUMNS)
      .eq("user_id", userId)
      .eq("id", opts.targetContactId)
      .maybeSingle();
    targetRow = (byId as ContactCoreRow | null) ?? undefined;
  }

  // ── Chunk-level sinks + school prefetch (CAR-47) ──
  // Emails, education rows, and tags are collected during the per-person
  // pass and flushed in bulk afterwards — still before this function
  // returns, so callers that re-read state (bundle fingerprinting) see
  // them. Schools resolve through one exact-name sweep; misses keep the
  // ilike find-or-create fallback.
  const schoolCache = new Map<string, { id: number } | null>();
  {
    const schoolNames = [
      ...new Set(
        working.flatMap((w) =>
          suppressed.has(w.mapped.linkedin_url)
            ? []
            : w.mapped.education.map((e) => e.school_name.trim()).filter(Boolean),
        ),
      ),
    ];
    for (const chunk of chunkList(schoolNames)) {
      const { data } = await supabase.from("schools").select("id, name").in("name", chunk);
      for (const row of (data as Array<{ id: number; name: string }> | null) ?? []) {
        const key = row.name.toLowerCase();
        if (!schoolCache.has(key)) schoolCache.set(key, { id: row.id });
      }
    }
  }
  const sinks: ChunkSinks = {
    emails: [],
    education: [],
    educationKeys: new Set(),
    tags: new Map(),
    resolveSchool: async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const key = trimmed.toLowerCase();
      const cached = schoolCache.get(key);
      if (cached !== undefined) return cached;
      const school = await findOrCreateSchool(supabase, trimmed);
      schoolCache.set(key, school);
      return school;
    },
  };

  // ── Per-person persistence ──
  // Updates run inline; creates are deferred into ONE bulk contacts insert
  // for the chunk (CAR-57) — results are pushed here in input order and
  // hold live references, so the bulk pass mutates them in place.
  const pendingCreates: PendingCreate[] = [];
  for (const w of working) {
    const { mapped } = w;
    if (suppressed.has(mapped.linkedin_url)) {
      w.result.status = "skipped_suppressed";
      results.push(w.result);
      continue;
    }

    try {
      const existing =
        urlMap.get(mapped.linkedin_url) ??
        (mapped.public_identifier ? pidMap.get(mapped.public_identifier) : undefined) ??
        targetRow;
      w.existingPhotoUrl = existing?.photo_url ?? null;

      // Profile location row (only created when it will actually be used)
      let profileLocationId: number | null = null;
      const needsProfileLocation = !existing || existing.location_id == null;
      if (needsProfileLocation) {
        if (mapped.resolved_profile_location_id !== undefined) {
          profileLocationId = mapped.resolved_profile_location_id; // snapshot (CAR-62)
        } else {
          const profileNorm = mapped.profile_location
            ? normalizeParsedLocation(mapped.profile_location)
            : normalizeLocation(mapped.profile_location_raw);
          if (locationMatchKey(profileNorm)) {
            profileLocationId = await resolveLocationId(profileNorm);
          }
        }
      }

      if (existing) {
        await updateExistingPerson(supabase, w, existing, profileLocationId, now, policy, sinks, opts.hooks);
      } else if (policy === "rescrape") {
        // A rescrape targets an existing contact; if it vanished (deleted
        // mid-run), record it rather than resurrecting it from thin data.
        w.result.status = "error";
        w.result.error = "Contact not found for rescrape";
      } else {
        pendingCreates.push({ w, row: buildContactInsertRow(userId, w.mapped, profileLocationId, now, opts), profileLocationId });
      }
      results.push(w.result);
    } catch (err) {
      results.push({
        ...w.result,
        status: "error",
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  // ── Bulk create path (CAR-57) ──
  await bulkCreatePersons(supabase, userId, pendingCreates, now, policy, opts, sinks);

  // ── Flush chunk-level sinks (CAR-47): bulk writes, per-row fallback ──
  if (sinks.emails.length > 0) {
    const { error } = await supabase.from("contact_emails").insert(sinks.emails);
    if (error) {
      for (const row of sinks.emails) await supabase.from("contact_emails").insert(row);
    }
  }
  if (sinks.education.length > 0) {
    // Ignore-duplicates upsert on the unique index: residual collisions
    // (concurrent writers) can't poison the batch into per-row work (CAR-62).
    const { error } = await supabase
      .from("contact_schools")
      .upsert(sinks.education, { onConflict: "contact_id,school_id,start_year", ignoreDuplicates: true });
    if (error) {
      for (const row of sinks.education) await supabase.from("contact_schools").insert(row);
    }
  }
  await addTagsToContacts(supabase, userId, sinks.tags);

  // ── Best-effort photos within a strict budget ──
  const deadline = Date.now() + PHOTO_BUDGET_MS;
  for (const w of working) {
    if (!w.contactId || !w.mapped.photo_url) {
      if (w.result.status === "created" || w.result.status === "updated") w.result.photo = "none";
      continue;
    }
    // Shared bundle photos are already in R2 — the persistence pass wrote
    // the URL as a plain column value; nothing to download.
    if (isBundlePhotoUrl(w.mapped.photo_url)) {
      w.result.photo = "stored";
      continue;
    }
    if (opts.skipPhotos) {
      w.result.photo = "skipped";
      continue;
    }
    // Rescrapes are fill-empty on photos: a contact who already has one (user
    // upload from the photo feature, or a prior import) keeps it.
    if (policy === "rescrape" && w.existingPhotoUrl) {
      w.result.photo = "skipped";
      continue;
    }
    if (Date.now() > deadline) {
      w.result.photo = "skipped";
      continue;
    }
    try {
      await downloadAndStorePhoto(supabase, userId, w.contactId, w.mapped.photo_url);
      w.result.photo = "stored";
    } catch {
      w.result.photo = "skipped";
    }
  }

  if (opts.analyticsSource) {
    const createdCount = results.filter((r) => r.status === "created").length;
    if (createdCount > 0) {
      const analytics = trackServer(userId, "contact_imported", {
        source: opts.analyticsSource,
        count: createdCount,
        // Path instrumentation (CAR-78): bundle imports through the merge
        // engine are the slow path; the fast path stamps fast: true itself.
        ...(opts.analyticsSource === "bundle" ? { fast: false } : {}),
      }).then(() => checkContactMilestone(userId));
      if (opts.deferAnalytics) opts.deferAnalytics(analytics);
      else await analytics;
    }
  }

  return { results, offices_established: officesEstablished };
}

// ── Create path (bulk per chunk, CAR-57) ──────────────────────────────

export function buildContactInsertRow(
  userId: string,
  mapped: MappedPerson,
  profileLocationId: number | null,
  now: string,
  opts: ImportChunkOptions,
): Record<string, unknown> {
  const noteLabel =
    opts.noteLabel ?? `Imported from PM recruiting pipeline${opts.batch ? ` (${opts.batch})` : ""}`;
  const initialNotes = [
    `${noteLabel} on ${new Date(now).toLocaleDateString()}`,
    mapped.history_highlights,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    user_id: userId,
    name: mapped.name,
    linkedin_url: mapped.linkedin_url,
    public_identifier: mapped.public_identifier,
    headline: mapped.headline,
    persona: mapped.persona,
    review_note: mapped.review_note,
    verified_school: mapped.verified_school,
    network_status: mapped.network_status,
    network_scope: mapped.network_scope,
    import_source: mapped.import_source,
    import_meta: mapped.import_meta,
    // Shared bundle photos (already in R2) land directly on the row;
    // external CDN URLs go through the mirror phase instead.
    photo_url: isBundlePhotoUrl(mapped.photo_url) ? mapped.photo_url : null,
    last_scraped_at: now,
    location_id: profileLocationId,
    notes: initialNotes,
    contact_status: "professional",
    status_derived_at: now,
  };
}

function markCreated(w: WorkingPerson, contactId: number) {
  w.contactId = contactId;
  w.created = true;
  w.result.status = "created";
  w.result.contact_id = contactId;
  w.result.network_status = w.mapped.network_status;
}

/** Re-look-up a contact after a failed single-row insert: covers a racing
 * insert from a non-claimed writer (and a future unique index) — found →
 * the person merges instead of erroring. */
async function refetchExistingContact(
  supabase: SupabaseClient,
  userId: string,
  mapped: MappedPerson,
): Promise<ContactCoreRow | undefined> {
  const { data: byUrl } = await supabase
    .from("contacts")
    .select(CONTACT_CORE_COLUMNS)
    .eq("user_id", userId)
    .eq("linkedin_url", mapped.linkedin_url)
    .limit(1);
  const urlHit = (byUrl as ContactCoreRow[] | null)?.[0];
  if (urlHit) return urlHit;
  if (!mapped.public_identifier) return undefined;
  const { data: byPid } = await supabase
    .from("contacts")
    .select(CONTACT_CORE_COLUMNS)
    .eq("user_id", userId)
    .eq("public_identifier", mapped.public_identifier)
    .limit(1);
  return (byPid as ContactCoreRow[] | null)?.[0];
}

/**
 * Create every genuinely-new person of the chunk in two bulk statements:
 * one `contacts` insert (ids mapped back from RETURNING) and one
 * `contact_companies` insert across the whole chunk. Either bulk write
 * failing degrades to per-row/per-person work (CAR-47 pattern) so one
 * malformed prospect can't sink the other 49 — per-person `result.status`
 * stays accurate throughout.
 */
async function bulkCreatePersons(
  supabase: SupabaseClient,
  userId: string,
  pending: PendingCreate[],
  now: string,
  policy: MergePolicy,
  opts: ImportChunkOptions,
  sinks: ChunkSinks,
) {
  if (pending.length === 0) return;

  const { data: created, error } = await supabase
    .from("contacts")
    .insert(pending.map((p) => p.row))
    .select("id, linkedin_url");
  const createdRows = (created as Array<{ id: number; linkedin_url: string | null }> | null) ?? [];

  if (!error && createdRows.length === pending.length) {
    // RETURNING preserves VALUES order in Postgres; the linkedin_url
    // cross-check guards the assumption, falling back to URL matching
    // (URLs are unique within a chunk on every current caller).
    const positional = createdRows.every((r, i) => r.linkedin_url === pending[i].w.mapped.linkedin_url);
    const byUrl = positional ? null : new Map(createdRows.map((r) => [r.linkedin_url, r.id]));
    for (let i = 0; i < pending.length; i++) {
      const id = positional ? createdRows[i].id : byUrl!.get(pending[i].w.mapped.linkedin_url);
      if (id != null) {
        markCreated(pending[i].w, id);
      } else {
        pending[i].w.result.status = "error";
        pending[i].w.result.error = "Failed to create contact";
      }
    }
  } else {
    // Bulk insert failed (or returned short) → per-row fallback. A row
    // that still fails is re-checked for an existing contact and merged
    // as an update when found.
    for (const p of pending) {
      try {
        const { data: contact, error: rowError } = await supabase
          .from("contacts")
          .insert(p.row)
          .select("id")
          .single();
        if (!rowError && contact) {
          markCreated(p.w, (contact as { id: number }).id);
          continue;
        }
        const existing = await refetchExistingContact(supabase, userId, p.w.mapped);
        if (!existing) throw new Error(rowError?.message ?? "Failed to create contact");
        p.w.existingPhotoUrl = existing.photo_url;
        await updateExistingPerson(supabase, p.w, existing, p.profileLocationId, now, policy, sinks, opts.hooks);
      } catch (err) {
        p.w.result.status = "error";
        p.w.result.error = err instanceof Error ? err.message : "Import failed";
      }
    }
  }

  // ── Created persons: emails + one chunk-wide employment insert ──
  const createdPending = pending.filter((p) => p.w.created && p.w.result.status === "created");

  for (const p of createdPending) {
    const { mapped } = p.w;
    // Email — collected; the chunk flush bulk-inserts it (CAR-47)
    if (mapped.email && isValidImportEmail(mapped.email.address)) {
      sinks.emails.push({
        contact_id: p.w.contactId,
        email: mapped.email.address,
        is_primary: true,
        source: mapped.email.source,
      });
    }
  }

  const employmentRowsOf = (p: PendingCreate) =>
    p.w.employment.map((e) => ({ contact_id: p.w.contactId, ...e.incoming, source: "scraped", scraped_at: now }));
  const withEmployment = createdPending.filter((p) => p.w.employment.length > 0);
  const allEmploymentRows = withEmployment.flatMap(employmentRowsOf);
  if (allEmploymentRows.length > 0) {
    const { error: empError } = await supabase.from("contact_companies").insert(allEmploymentRows);
    if (empError) {
      // Per-person fallback: a person whose rows still fail is marked
      // error (contact exists, employment didn't — same as the old
      // per-person throw); everyone else keeps accurate counts.
      for (const p of withEmployment) {
        const { error: rowError } = await supabase.from("contact_companies").insert(employmentRowsOf(p));
        if (rowError) {
          p.w.result.status = "error";
          p.w.result.error = `Employment insert failed: ${rowError.message}`;
        } else {
          p.w.result.employment = { inserted: p.w.employment.length, updated: 0, deleted: 0 };
        }
      }
    } else {
      for (const p of withEmployment) {
        p.w.result.employment = { inserted: p.w.employment.length, updated: 0, deleted: 0 };
      }
    }
  }

  // ── Education / tags / tracker — skipped for persons that errored above
  // (matches the old per-person flow, where the employment throw aborted
  // the rest of that person's steps) ──
  for (const p of createdPending) {
    if (p.w.result.status !== "created") continue;
    const { mapped, input } = p.w;
    const contactId = p.w.contactId!;
    try {
      // Education — a just-created contact has none, so no existing-rows check
      await collectEducation(contactId, p.w, sinks, { checkExisting: false, supabase });

      // Tags — collected; flushed for the whole chunk in one batched pass.
      // Merge, don't overwrite — two chunk entries can resolve to the same
      // contact (url variant + public_identifier match), and the second must
      // not clobber the first's tags (CAR-47 audit).
      if (mapped.tags.length > 0) {
        const priorTags = sinks.tags.get(contactId);
        sinks.tags.set(contactId, priorTags ? [...priorTags, ...mapped.tags] : mapped.tags);
      }

      // Tracker outreach state — applies ONLY on first import (contract:
      // after that, CareerVine owns outreach state)
      await applyTrackerState(supabase, userId, contactId, input.tracker, now);
    } catch (err) {
      p.w.result.status = "error";
      p.w.result.error = err instanceof Error ? err.message : "Import failed";
    }
  }
}

// ── Update path ────────────────────────────────────────────────────────

async function updateExistingPerson(
  supabase: SupabaseClient,
  w: WorkingPerson,
  existing: {
    id: number;
    name: string;
    persona: string | null;
    network_status: string;
    location_id: number | null;
    headline: string | null;
    public_identifier: string | null;
    photo_url: string | null;
  },
  profileLocationId: number | null,
  now: string,
  policy: MergePolicy,
  sinks: ChunkSinks,
  hooks: ImportHooks = {},
) {
  const { mapped } = w;
  const contactId = existing.id;
  w.contactId = contactId;
  w.result.status = "updated";
  w.result.contact_id = contactId;

  const { patch, personaConflict } = computeContactPatch(existing, mapped, now, profileLocationId, policy);
  if (personaConflict) w.result.persona_conflict = personaConflict;
  // Keep the canonical URL current (fixes pre-normalizer variants and
  // internal-id → vanity upgrades matched via public_identifier)
  patch.linkedin_url = mapped.linkedin_url;
  if (bundlePhotoOverwriteAllowed(existing.photo_url, mapped.photo_url)) {
    patch.photo_url = mapped.photo_url;
  }
  const { error: patchError } = await supabase.from("contacts").update(patch).eq("id", contactId);
  if (patchError) throw new Error(`Contact update failed: ${patchError.message}`);
  w.result.applied_patch = patch;
  w.result.network_status = (patch.network_status as string | undefined) ?? existing.network_status;

  // Emails: monotonic upgrade only
  if (mapped.email && isValidImportEmail(mapped.email.address)) {
    const { data: emailRows } = await supabase
      .from("contact_emails")
      .select("id, email, is_primary, source, bounced_at")
      .eq("contact_id", contactId);
    const emailPlan = computeEmailMerge(
      (emailRows as { id: number; email: string | null; is_primary: boolean; source: string; bounced_at: string | null }[] | null) ?? [],
      mapped.email,
    );
    // Demote bounced former primaries BEFORE the new primary lands, so the
    // contact never has two primary rows mid-apply.
    if (emailPlan.demotePrimaryIds?.length) {
      const { error: demoteError } = await supabase
        .from("contact_emails")
        .update({ is_primary: false })
        .in("id", emailPlan.demotePrimaryIds);
      if (demoteError) throw new Error(`Email primary demotion failed: ${demoteError.message}`);
    }
    if (emailPlan.insert) await supabase.from("contact_emails").insert({ contact_id: contactId, ...emailPlan.insert });
    if (emailPlan.update) await supabase.from("contact_emails").update(emailPlan.update.fields).eq("id", emailPlan.update.id);
  }

  // Employment merge
  const { data: existingEmpRows } = await supabase
    .from("contact_companies")
    .select("id, company_id, title, start_month, end_month, is_current, location_id, location_source, location_raw, workplace_type, employment_type, source")
    .eq("contact_id", contactId);

  // Capture the PRE-merge state for the scrape-diff engine (plan 29 §5).
  if (hooks.onDiffCapture) {
    hooks.onDiffCapture({
      contactId,
      contactName: existing.name,
      linkedinUrl: mapped.linkedin_url,
      existingEmployment: ((existingEmpRows as ExistingEmploymentRow[] | null) ?? []).map((r) => ({
        company_id: r.company_id,
        title: r.title,
        start_month: r.start_month,
        is_current: r.is_current,
      })),
      incomingEmployment: w.employment.map((e) => ({
        company_id: e.company.id,
        linkedin_company_id: e.company.linkedin_company_id,
        company_name: e.company.name,
        title: e.incoming.title,
        start_month: e.incoming.start_month,
        is_current: e.incoming.is_current,
      })),
    });
  }

  const plan = computeEmploymentMerge(
    (existingEmpRows as ExistingEmploymentRow[] | null) ?? [],
    w.employment.map((e) => e.incoming),
    now,
    // Rescrape reconciles same-company current-role collisions by provenance
    // (supersede AI-parsed/scraped rows, never manual — plan 29 M2).
    { policy, currentCollisionStrategy: policy === "rescrape" ? "reconcile" : "insert" },
  );
  if (plan.inserts.length > 0) {
    const { error: insError } = await supabase
      .from("contact_companies")
      .insert(plan.inserts.map((r) => ({ contact_id: contactId, ...r })));
    if (insError) throw new Error(`Employment insert failed: ${insError.message}`);
  }
  for (const update of plan.updates) {
    const { error: updError } = await supabase.from("contact_companies").update(update.fields).eq("id", update.id);
    // A silently-failed supersede would make the diff re-detect the same change
    // (and re-fire its email follow-up) every cycle — fail the merge instead.
    if (updError) throw new Error(`Employment update failed: ${updError.message}`);
  }
  if (plan.deleteIds.length > 0) {
    const { error: delError } = await supabase.from("contact_companies").delete().in("id", plan.deleteIds);
    if (delError) throw new Error(`Employment delete failed: ${delError.message}`);
  }
  w.result.employment = {
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    deleted: plan.deleteIds.length,
  };

  // Education (additive)
  await collectEducation(contactId, w, sinks, { checkExisting: true, supabase });

  // Tags (additive) — collected; flushed for the whole chunk in one pass
  if (mapped.tags.length > 0) {
    // Merge, don't overwrite — two chunk entries can resolve to the same
    // contact (url variant + public_identifier match), and the second must
    // not clobber the first's tags (CAR-47 audit).
    const priorTags = sinks.tags.get(contactId);
    sinks.tags.set(contactId, priorTags ? [...priorTags, ...mapped.tags] : mapped.tags);
  }
}

// ── Education ──────────────────────────────────────────────────────────

/**
 * Resolve a person's education rows into the chunk sink (CAR-47). Schools
 * come from the chunk's prefetched cache (ilike find-or-create on miss);
 * `checkExisting` is skipped for just-created contacts, which can't have
 * education rows yet. Inserts land in the chunk flush.
 */
async function collectEducation(
  contactId: number,
  w: WorkingPerson,
  sinks: ChunkSinks,
  opts: { checkExisting: boolean; supabase: SupabaseClient },
) {
  if (w.mapped.education.length === 0) return;

  // Dedupe key: for a real start_year it mirrors the DB unique index
  // (contact_id, school_id, start_year) so double majors at the same
  // school+year collapse to one row (the index can only hold one anyway) —
  // this is what stopped the batch-poisoning per-row fallback (~61s/sync,
  // CAR-62). But that index is NULLS-DISTINCT, so two rows with a NULL
  // start_year do NOT collide in the DB; collapsing them on school alone
  // would silently drop a legitimately-distinct degree, so when start_year
  // is null the key falls back to including degree/field (CAR-62 review).
  const existingKeys = new Set<string>();
  if (opts.checkExisting) {
    const { data: existingRows } = await opts.supabase
      .from("contact_schools")
      .select("school_id, degree, field_of_study, start_year")
      .eq("contact_id", contactId);
    for (const r of (existingRows as Array<{ school_id: number; degree: string | null; field_of_study: string | null; start_year: number | null }> | null) ?? []) {
      existingKeys.add(educationDedupeKey(r.school_id, r.start_year, r.degree, r.field_of_study));
    }
  }

  for (const edu of w.mapped.education) {
    const school =
      edu.resolved_school_id != null ? { id: edu.resolved_school_id } : await sinks.resolveSchool(edu.school_name);
    if (!school) continue;
    const key = educationDedupeKey(school.id, edu.start_year, edu.degree, edu.field_of_study);
    const chunkKey = `${contactId}|${key}`;
    if (existingKeys.has(key) || sinks.educationKeys.has(chunkKey)) continue;
    existingKeys.add(key);
    sinks.educationKeys.add(chunkKey);
    sinks.education.push({
      contact_id: contactId,
      school_id: school.id,
      degree: edu.degree,
      field_of_study: edu.field_of_study,
      start_year: edu.start_year,
      end_year: edu.end_year,
    });
  }
}

/** In-code dedupe key for a contact's education rows (CAR-62). A real
 * start_year keys on (school_id, start_year) to match the DB unique index;
 * a NULL start_year falls back to including degree/field because the index
 * is NULLS-DISTINCT and would keep both distinct-degree rows. Shared with the
 * bundle fast-apply path so both dedupe identically. */
export function educationDedupeKey(
  schoolId: number,
  startYear: number | null | undefined,
  degree: string | null | undefined,
  field: string | null | undefined,
): string {
  return startYear != null
    ? `${schoolId}|${startYear}`
    : `${schoolId}||${(degree ?? "").toLowerCase()}|${(field ?? "").toLowerCase()}`;
}

export async function findOrCreateSchool(supabase: SupabaseClient, name: string): Promise<{ id: number } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { data: found } = await supabase
    .from("schools")
    .select("id")
    .ilike("name", escapeIlike(trimmed))
    .limit(1);
  const existing = (found as { id: number }[] | null)?.[0];
  if (existing) return existing;
  const { data: created, error } = await supabase.from("schools").insert({ name: trimmed }).select("id").single();
  if (!error && created) return created as { id: number };
  const { data: retry } = await supabase.from("schools").select("id").ilike("name", escapeIlike(trimmed)).limit(1);
  return (retry as { id: number }[] | null)?.[0] ?? null;
}

// ── Tracker state (first import only) ──────────────────────────────────

async function applyTrackerState(
  supabase: SupabaseClient,
  userId: string,
  contactId: number,
  tracker: TrackerState | null | undefined,
  now: string,
) {
  if (!tracker) return;
  const stage = tracker.stage?.trim();

  if (stage && stage !== "not_contacted") {
    // Manual override so the derived stage reflects pre-CareerVine outreach
    await supabase.from("contacts").update({ stage_override: stage }).eq("id", contactId);
    // A logged interaction so timeline + derived stages work naturally
    await supabase.from("interactions").insert({
      contact_id: contactId,
      interaction_date: tracker.last_touch || now,
      interaction_type: "email",
      summary: `Outreach state imported from tracker: ${stage}`,
    });
  }

  if (tracker.next_action?.trim()) {
    await supabase.from("follow_up_action_items").insert({
      user_id: userId,
      contact_id: contactId,
      title: tracker.next_action.trim(),
      description: "Imported from Outreach_Tracker",
      due_at: tracker.next_action_date || null,
      source: "manual",
    });
  }

  if (tracker.notes?.trim()) {
    await supabase.rpc("append_contact_note", {
      p_contact_id: contactId,
      p_note: `[Tracker] ${tracker.notes.trim()}`,
    });
  }
}

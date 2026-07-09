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
  ensureCompanyLocation,
  escapeIlike,
  type CompanyRecord,
} from "./company-helpers";
import {
  computeEmploymentMerge,
  computeEmailMerge,
  computeContactPatch,
  type ExistingEmploymentRow,
  type IncomingEmploymentRow,
} from "./scrape-merge";
import { addTagsToContact, downloadAndStorePhoto, isValidImportEmail } from "./import-db-helpers";

// ── Input / output shapes ──────────────────────────────────────────────

export interface TrackerState {
  stage?: string | null;
  last_touch?: string | null;
  next_action?: string | null;
  next_action_date?: string | null;
  notes?: string | null;
}

export interface PersonImportInput {
  record: PeopleRecord;
  tracker?: TrackerState | null;
}

export interface PersonImportResult {
  linkedin_url: string | null;
  name: string | null;
  status: "created" | "updated" | "skipped_suppressed" | "error";
  network_status?: string;
  warnings: string[];
  persona_conflict?: { existing: string; incoming: string };
  employment?: { inserted: number; updated: number; deleted: number };
  photo?: "stored" | "skipped" | "none";
  error?: string;
}

export interface ChunkImportSummary {
  results: PersonImportResult[];
  offices_established: number;
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
}

interface WorkingPerson {
  input: PersonImportInput;
  mapped: MappedPerson;
  employment: WorkingEmployment[];
  result: PersonImportResult;
  contactId?: number;
  created?: boolean;
}

// ── Main entry ─────────────────────────────────────────────────────────

export async function importPeopleChunk(
  supabase: SupabaseClient,
  userId: string,
  people: PersonImportInput[],
  batch?: string,
  mode: "import" | "rescrape" = "import",
): Promise<ChunkImportSummary> {
  const now = new Date().toISOString();
  const results: PersonImportResult[] = [];
  const working: WorkingPerson[] = [];

  // ── Map every record; contract violations become per-record errors ──
  for (const input of people) {
    try {
      const mapped = mapPeopleRecord(input.record, { batch });
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
        linkedin_url: (input.record as PeopleRecord)?.identity?.linkedin_url ?? null,
        name: (input.record as PeopleRecord)?.identity?.name ?? null,
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
  if (mode !== "rescrape") {
    const { data: suppressedRows } = await supabase
      .from("suppressed_imports")
      .select("linkedin_url")
      .eq("user_id", userId)
      .in("linkedin_url", urls);
    for (const r of (suppressedRows as { linkedin_url: string }[] | null) ?? []) {
      suppressed.add(r.linkedin_url);
    }
  }

  // ── Resolve companies once per chunk ──
  const companyCache = new Map<string, CompanyRecord>();
  for (const w of working) {
    if (suppressed.has(w.mapped.linkedin_url)) continue;
    for (let i = 0; i < w.mapped.employment.length; i++) {
      const emp = w.mapped.employment[i];
      const cacheKey = emp.linkedin_company_id
        ? `id:${emp.linkedin_company_id}`
        : `name:${(emp.company_name ?? "").trim().toLowerCase()}`;
      let company = companyCache.get(cacheKey);
      if (!company) {
        company = await findOrCreateCompany(supabase, {
          name: emp.company_name,
          linkedin_company_id: emp.linkedin_company_id,
          linkedin_url: emp.company_linkedin_url,
          universal_name: emp.company_universal_name,
        });
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
  const locationIdCache = new Map<string, number>(); // matchKey → locations.id
  const chunkOffices = new Map<number, Map<string, number>>(); // company → key → location
  let officesEstablished = 0;

  async function resolveLocationId(norm: NormalizedLocation): Promise<number> {
    const key = locationMatchKey(norm)!;
    const cached = locationIdCache.get(key);
    if (cached != null) return cached;
    const { id } = await findOrCreateLocation(supabase, {
      city: norm.city,
      state: norm.state,
      country: norm.country ?? "United States",
    });
    locationIdCache.set(key, id);
    return id;
  }

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
        await ensureCompanyLocation(supabase, emp.company.id, locationId, "scraped");
        officesEstablished++;
      }
    }
  }

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
      if (!emp.incoming.is_current || emp.incoming.location_id != null || emp.isRemote) continue;
      const officeLocation = chunkOffices.get(emp.company.id)?.get(profileKey);
      if (officeLocation != null) {
        emp.incoming.location_id = officeLocation;
        emp.incoming.location_source = "profile_match";
      }
    }
  }

  // ── Existing-contact lookup (canonical url, then public_identifier) ──
  const { data: byUrl } = await supabase
    .from("contacts")
    .select("id, name, linkedin_url, public_identifier, persona, network_status, location_id, headline, photo_url")
    .eq("user_id", userId)
    .in("linkedin_url", urls);
  const pids = working.map((w) => w.mapped.public_identifier).filter(Boolean) as string[];
  const { data: byPid } = pids.length
    ? await supabase
        .from("contacts")
        .select("id, name, linkedin_url, public_identifier, persona, network_status, location_id, headline, photo_url")
        .eq("user_id", userId)
        .in("public_identifier", pids)
    : { data: [] };

  type ContactCoreRow = {
    id: number;
    name: string;
    linkedin_url: string | null;
    public_identifier: string | null;
    persona: string | null;
    network_status: string;
    location_id: number | null;
    headline: string | null;
    photo_url: string | null;
  };
  const urlMap = new Map<string, ContactCoreRow>();
  for (const c of (byUrl as ContactCoreRow[] | null) ?? []) {
    if (c.linkedin_url) urlMap.set(c.linkedin_url, c);
  }
  const pidMap = new Map<string, ContactCoreRow>();
  for (const c of (byPid as ContactCoreRow[] | null) ?? []) {
    if (c.public_identifier) pidMap.set(c.public_identifier, c);
  }

  // ── Per-person persistence ──
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
        (mapped.public_identifier ? pidMap.get(mapped.public_identifier) : undefined);

      // Profile location row (only created when it will actually be used)
      let profileLocationId: number | null = null;
      const profileNorm = mapped.profile_location
        ? normalizeParsedLocation(mapped.profile_location)
        : normalizeLocation(mapped.profile_location_raw);
      const needsProfileLocation = !existing || existing.location_id == null;
      if (needsProfileLocation && locationMatchKey(profileNorm)) {
        profileLocationId = await resolveLocationId(profileNorm);
      }

      if (existing) {
        await updateExistingPerson(supabase, w, existing, profileLocationId, now, mode);
      } else if (mode === "rescrape") {
        // A rescrape targets an existing contact; if it vanished (deleted
        // mid-run), record it rather than resurrecting it from thin data.
        w.result.status = "error";
        w.result.error = "Contact not found for rescrape";
      } else {
        await createNewPerson(supabase, userId, w, profileLocationId, now, batch);
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

  // ── Best-effort photos within a strict budget ──
  const deadline = Date.now() + PHOTO_BUDGET_MS;
  for (const w of working) {
    if (!w.contactId || !w.mapped.photo_url) {
      if (w.result.status === "created" || w.result.status === "updated") w.result.photo = "none";
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

  return { results, offices_established: officesEstablished };
}

// ── Create path ────────────────────────────────────────────────────────

async function createNewPerson(
  supabase: SupabaseClient,
  userId: string,
  w: WorkingPerson,
  profileLocationId: number | null,
  now: string,
  batch?: string,
) {
  const { mapped, input } = w;
  const initialNotes = [
    `Imported from PM recruiting pipeline${batch ? ` (${batch})` : ""} on ${new Date(now).toLocaleDateString()}`,
    mapped.history_highlights,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data: contact, error } = await supabase
    .from("contacts")
    .insert({
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
      last_scraped_at: now,
      location_id: profileLocationId,
      notes: initialNotes,
      contact_status: "professional",
      status_derived_at: now,
    })
    .select("id")
    .single();
  if (error || !contact) throw new Error(error?.message ?? "Failed to create contact");
  const contactId = (contact as { id: number }).id;
  w.contactId = contactId;
  w.created = true;
  w.result.status = "created";
  w.result.network_status = mapped.network_status;

  // Email
  if (mapped.email && isValidImportEmail(mapped.email.address)) {
    await supabase.from("contact_emails").insert({
      contact_id: contactId,
      email: mapped.email.address,
      is_primary: true,
      source: mapped.email.source,
    });
  }

  // Employment (all incoming, scraped-sourced)
  if (w.employment.length > 0) {
    const { error: empError } = await supabase.from("contact_companies").insert(
      w.employment.map((e) => ({ contact_id: contactId, ...e.incoming, source: "scraped", scraped_at: now })),
    );
    if (empError) throw new Error(`Employment insert failed: ${empError.message}`);
    w.result.employment = { inserted: w.employment.length, updated: 0, deleted: 0 };
  }

  // Education (additive)
  await upsertEducation(supabase, contactId, w);

  // Tags
  if (mapped.tags.length > 0) {
    await addTagsToContact(supabase, contactId, mapped.tags, userId);
  }

  // Tracker outreach state — applies ONLY on first import (contract:
  // after that, CareerVine owns outreach state)
  await applyTrackerState(supabase, userId, contactId, input.tracker, now);
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
  },
  profileLocationId: number | null,
  now: string,
  mode: "import" | "rescrape" = "import",
) {
  const { mapped } = w;
  const contactId = existing.id;
  w.contactId = contactId;
  w.result.status = "updated";

  const { patch, personaConflict } = computeContactPatch(existing, mapped, now, profileLocationId, mode);
  if (personaConflict) w.result.persona_conflict = personaConflict;
  // Keep the canonical URL current (fixes pre-normalizer variants and
  // internal-id → vanity upgrades matched via public_identifier)
  patch.linkedin_url = mapped.linkedin_url;
  const { error: patchError } = await supabase.from("contacts").update(patch).eq("id", contactId);
  if (patchError) throw new Error(`Contact update failed: ${patchError.message}`);
  w.result.network_status = (patch.network_status as string | undefined) ?? existing.network_status;

  // Emails: monotonic upgrade only
  if (mapped.email && isValidImportEmail(mapped.email.address)) {
    const { data: emailRows } = await supabase
      .from("contact_emails")
      .select("id, email, is_primary, source")
      .eq("contact_id", contactId);
    const emailPlan = computeEmailMerge(
      (emailRows as { id: number; email: string | null; is_primary: boolean; source: string }[] | null) ?? [],
      mapped.email,
    );
    if (emailPlan.insert) await supabase.from("contact_emails").insert({ contact_id: contactId, ...emailPlan.insert });
    if (emailPlan.update) await supabase.from("contact_emails").update(emailPlan.update.fields).eq("id", emailPlan.update.id);
  }

  // Employment merge
  const { data: existingEmpRows } = await supabase
    .from("contact_companies")
    .select("id, company_id, title, start_month, end_month, is_current, location_id, location_source, location_raw, workplace_type, employment_type, source")
    .eq("contact_id", contactId);
  const plan = computeEmploymentMerge(
    (existingEmpRows as ExistingEmploymentRow[] | null) ?? [],
    w.employment.map((e) => e.incoming),
    now,
    // Enrich/rescrape supersedes an AI-parsed current role instead of
    // inserting a duplicate (plan 29 M2).
    { supersedeManualCurrent: mode === "rescrape" },
  );
  if (plan.inserts.length > 0) {
    const { error: insError } = await supabase
      .from("contact_companies")
      .insert(plan.inserts.map((r) => ({ contact_id: contactId, ...r })));
    if (insError) throw new Error(`Employment insert failed: ${insError.message}`);
  }
  for (const update of plan.updates) {
    await supabase.from("contact_companies").update(update.fields).eq("id", update.id);
  }
  if (plan.deleteIds.length > 0) {
    await supabase.from("contact_companies").delete().in("id", plan.deleteIds);
  }
  w.result.employment = {
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    deleted: plan.deleteIds.length,
  };

  // Education (additive)
  await upsertEducation(supabase, contactId, w);

  // Tags (additive)
  if (mapped.tags.length > 0) {
    const { data: userRow } = await supabase.from("contacts").select("user_id").eq("id", contactId).single();
    if (userRow) await addTagsToContact(supabase, contactId, mapped.tags, (userRow as { user_id: string }).user_id);
  }
}

// ── Education ──────────────────────────────────────────────────────────

async function upsertEducation(supabase: SupabaseClient, contactId: number, w: WorkingPerson) {
  if (w.mapped.education.length === 0) return;

  const { data: existingRows } = await supabase
    .from("contact_schools")
    .select("school_id, degree, field_of_study, start_year")
    .eq("contact_id", contactId);
  const existingKeys = new Set(
    ((existingRows as Array<{ school_id: number; degree: string | null; field_of_study: string | null; start_year: number | null }> | null) ?? []).map(
      (r) => `${r.school_id}|${(r.degree ?? "").toLowerCase()}|${(r.field_of_study ?? "").toLowerCase()}|${r.start_year ?? ""}`,
    ),
  );

  for (const edu of w.mapped.education) {
    const school = await findOrCreateSchool(supabase, edu.school_name);
    if (!school) continue;
    const key = `${school.id}|${(edu.degree ?? "").toLowerCase()}|${(edu.field_of_study ?? "").toLowerCase()}|${edu.start_year ?? ""}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    await supabase.from("contact_schools").insert({
      contact_id: contactId,
      school_id: school.id,
      degree: edu.degree,
      field_of_study: edu.field_of_study,
      start_year: edu.start_year,
      end_year: edu.end_year,
    });
  }
}

async function findOrCreateSchool(supabase: SupabaseClient, name: string): Promise<{ id: number } | null> {
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

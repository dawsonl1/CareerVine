/**
 * Maps one pipeline people-record (people/<company>/<name>.json,
 * schema_version 1) to CareerVine shapes.
 *
 * Contract: PM Recruiting/Target Companies/pipeline/README.md (§6).
 * Key rules:
 *  - identity.linkedin_url is the join key; canonicalize it.
 *  - Employment/education come from raw_profiles[].data (the untouched
 *    actor item) — NEVER from identity.company, which is CANON-mapped for
 *    display ("Google DeepMind" → "Google") and would glue subsidiaries to
 *    the parent company.
 *  - Handles both actor shapes (profile-search: currentPosition[],
 *    employees: currentPositions[]) and emails[] as strings or objects.
 *  - crm.email_source uses hyphens (pattern-guessed) → ours uses
 *    underscores; '' → no email.
 *  - SELECTED → network_status 'prospect'; BENCH → 'bench'.
 *
 * Pure module — no DB access. The bulk-import route owns persistence.
 */

import { canonicalizeLinkedinUrl, extractPublicIdentifier, extractCompanyUniversalName, isInternalLinkedinId } from "./linkedin-url";

// ── Pipeline record types (schema_version 1) ───────────────────────────

interface ActorDate {
  month?: string | null;
  year?: number | string | null;
  text?: string | null;
}

interface ActorExperience {
  position?: string | null;
  location?: string | null;
  employmentType?: string | null;
  workplaceType?: string | null;
  companyName?: string | null;
  companyLinkedinUrl?: string | null;
  companyId?: string | number | null;
  startDate?: ActorDate | null;
  endDate?: ActorDate | null;
  description?: string | null;
}

interface ActorEducation {
  schoolName?: string | null;
  degree?: string | null;
  fieldOfStudy?: string | null;
  startDate?: ActorDate | null;
  endDate?: ActorDate | null;
}

interface ActorProfileData {
  linkedinUrl?: string | null;
  publicIdentifier?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  photo?: string | null;
  location?: {
    linkedinText?: string | null;
    parsed?: { city?: string | null; state?: string | null; country?: string | null } | null;
  } | null;
  emails?: Array<string | { email?: string | null }> | null;
  experience?: ActorExperience[] | null;
  education?: ActorEducation[] | null;
  [key: string]: unknown;
}

export interface PeopleRecord {
  schema_version: number | string;
  identity: {
    name: string;
    linkedin_url: string;
    company?: string | null;
    title?: string | null;
    location?: string | null;
    school?: string | null;
    tenure?: string | null;
  };
  pipeline: {
    found_by_searches?: string | null;
    persona?: string | null;
    priority_rank?: string | number | null;
    adjacency_score?: string | number | null;
    review_verdict?: string | null;
    review_reason?: string | null;
    selected_contact?: string | null;
    selection_reason?: string | null;
    review_sheet?: string | null;
  };
  crm: {
    email?: string | null;
    email_source?: string | null;
    stage?: string | null;
    tags?: string[] | null;
    history_highlights?: string | null;
  };
  raw_profiles?: Array<{ source?: string | null; data?: ActorProfileData | null }> | null;
  history?: Array<Record<string, unknown>> | null;
}

// ── Output shapes ──────────────────────────────────────────────────────

export interface MappedEmployment {
  title: string | null;
  company_name: string | null;
  linkedin_company_id: string | null;
  company_linkedin_url: string | null;
  company_universal_name: string | null;
  start_month: string | null;
  end_month: string | null;
  is_current: boolean;
  workplace_type: "on_site" | "hybrid" | "remote" | null;
  employment_type: string | null;
  location_raw: string | null;
}

export interface MappedEducation {
  school_name: string;
  degree: string | null;
  field_of_study: string | null;
  start_year: number | null;
  end_year: number | null;
}

export interface MappedPerson {
  name: string;
  linkedin_url: string;
  public_identifier: string | null;
  non_vanity_url: boolean;
  headline: string | null;
  persona: string | null;
  review_note: string | null;
  verified_school: string | null;
  network_status: "prospect" | "bench";
  import_source: string;
  import_meta: Record<string, unknown>;
  tags: string[];
  history_highlights: string | null;
  profile_location_raw: string | null;
  profile_location: { city: string | null; state: string | null; country: string | null } | null;
  photo_url: string | null;
  email: { address: string; source: "scraped" | "pattern_guessed" | "verified" } | null;
  employment: MappedEmployment[];
  education: MappedEducation[];
  warnings: string[];
}

// ── Constants ──────────────────────────────────────────────────────────

const PERSONAS = new Set(["alum_product", "alum_other", "product_peer", "product_leader", "recruiter"]);
const SCHOOLS = new Set(["BYU", "BYU-Idaho", "Marriott", "none"]);

const EMAIL_SOURCE_MAP: Record<string, "scraped" | "pattern_guessed" | "verified"> = {
  scraped: "scraped",
  "pattern-guessed": "pattern_guessed",
  pattern_guessed: "pattern_guessed",
  verified: "verified",
};

const WORKPLACE_TYPE_MAP: Record<string, "on_site" | "hybrid" | "remote"> = {
  "on-site": "on_site",
  onsite: "on_site",
  "on site": "on_site",
  hybrid: "hybrid",
  remote: "remote",
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Format an actor date as CareerVine's "Mon YYYY" month text. */
export function formatActorDate(d: ActorDate | null | undefined): string | null {
  if (!d) return null;
  const year = d.year != null && String(d.year).trim() !== "" ? String(d.year).trim() : null;
  const month = d.month?.trim() || null;
  if (month && year) return `${month} ${year}`;
  if (year) return year;
  const text = d.text?.trim();
  if (text && text.toLowerCase() !== "present") return text;
  return null;
}

function actorYear(d: ActorDate | null | undefined): number | null {
  if (!d) return null;
  const y = parseInt(String(d.year ?? ""), 10);
  if (!Number.isNaN(y)) return y;
  const fromText = parseInt(String(d.text ?? ""), 10);
  return Number.isNaN(fromText) ? null : fromText;
}

/**
 * True when the role is current: explicit "Present" end date, or no end
 * date at all (LinkedIn semantics — an experience entry without an end
 * date is an ongoing role).
 */
function isCurrentRole(exp: ActorExperience): boolean {
  const end = exp.endDate;
  if (!end || Object.keys(end).length === 0) return true;
  return (end.text ?? "").trim().toLowerCase() === "present";
}

function mapWorkplaceType(wt: string | null | undefined): "on_site" | "hybrid" | "remote" | null {
  if (!wt) return null;
  return WORKPLACE_TYPE_MAP[wt.trim().toLowerCase()] ?? null;
}

function normalizeEmailEntry(entry: string | { email?: string | null } | null | undefined): string | null {
  if (!entry) return null;
  const address = typeof entry === "string" ? entry : entry.email;
  const trimmed = address?.trim().toLowerCase();
  return trimmed || null;
}

/**
 * Pick the richest raw profile when a person was found by several
 * searches: most experience entries wins; ties go to the later entry
 * (raw_profiles are appended in scrape order, so later = newer).
 */
export function pickRichestProfile(
  rawProfiles: PeopleRecord["raw_profiles"],
): ActorProfileData | null {
  if (!rawProfiles?.length) return null;
  let best: ActorProfileData | null = null;
  let bestCount = -1;
  for (const entry of rawProfiles) {
    const data = entry?.data;
    if (!data) continue;
    const count = data.experience?.length ?? 0;
    if (count >= bestCount) {
      best = data;
      bestCount = count;
    }
  }
  return best;
}

// ── Main mapper ────────────────────────────────────────────────────────

export interface MapOptions {
  /** Import batch label appended to import_source (e.g. "2026-07_tranche1"). */
  batch?: string;
}

export class ScrapeMappingError extends Error {}

/**
 * Map one pipeline people-record to CareerVine shapes.
 * Throws ScrapeMappingError on contract violations (wrong schema_version,
 * missing linkedin_url); soft problems land in warnings.
 */
export function mapPeopleRecord(record: PeopleRecord, opts: MapOptions = {}): MappedPerson {
  const warnings: string[] = [];

  const schemaVersion = String(record.schema_version ?? "");
  if (schemaVersion !== "1") {
    throw new ScrapeMappingError(`Unsupported schema_version "${schemaVersion}" (expected "1")`);
  }
  if (!record.identity?.name) {
    throw new ScrapeMappingError("Record has no identity.name");
  }

  const canonicalUrl = canonicalizeLinkedinUrl(record.identity.linkedin_url);
  if (!canonicalUrl) {
    throw new ScrapeMappingError(`Record has no usable identity.linkedin_url: "${record.identity?.linkedin_url}"`);
  }
  const slug = canonicalUrl.slice(canonicalUrl.lastIndexOf("/") + 1);
  const nonVanity = isInternalLinkedinId(slug);
  if (nonVanity) {
    warnings.push("non_vanity_url");
  }

  const raw = pickRichestProfile(record.raw_profiles);

  // Persona / school: validate against enums, report rather than reject
  const persona = record.pipeline?.persona && PERSONAS.has(record.pipeline.persona) ? record.pipeline.persona : null;
  if (record.pipeline?.persona && !persona) warnings.push(`unknown_persona:${record.pipeline.persona}`);
  const verifiedSchool = record.identity?.school && SCHOOLS.has(record.identity.school) ? record.identity.school : null;
  if (record.identity?.school && !verifiedSchool) warnings.push(`unknown_school:${record.identity.school}`);

  // Network tier
  const selected = (record.pipeline?.selected_contact ?? "").trim().toUpperCase();
  const networkStatus: "prospect" | "bench" = selected === "BENCH" ? "bench" : "prospect";
  if (selected !== "SELECTED" && selected !== "BENCH") {
    warnings.push(`unknown_selected_contact:${record.pipeline?.selected_contact ?? ""}`);
  }

  // Email: crm.email is the pipeline's pick; source hyphen → underscore
  let email: MappedPerson["email"] = null;
  const emailAddress = record.crm?.email?.trim().toLowerCase() || null;
  if (emailAddress) {
    const source = EMAIL_SOURCE_MAP[(record.crm?.email_source ?? "").trim().toLowerCase()] ?? "scraped";
    email = { address: emailAddress, source };
  } else if (raw?.emails?.length) {
    // Fallback: pipeline didn't fill crm.email but the actor found one
    const fromRaw = normalizeEmailEntry(raw.emails[0]);
    if (fromRaw) email = { address: fromRaw, source: "scraped" };
  }

  // Provenance
  const foundBy = record.pipeline?.found_by_searches?.trim() || "unknown";
  const importSource = opts.batch ? `apify:${foundBy}:${opts.batch}` : `apify:${foundBy}`;
  const importMeta: Record<string, unknown> = {
    found_by_searches: record.pipeline?.found_by_searches ?? null,
    priority_rank: toNumberOrNull(record.pipeline?.priority_rank),
    adjacency_score: toNumberOrNull(record.pipeline?.adjacency_score),
    review_verdict: record.pipeline?.review_verdict ?? null,
    selected_contact: record.pipeline?.selected_contact ?? null,
    selection_reason: record.pipeline?.selection_reason ?? null,
    review_sheet: record.pipeline?.review_sheet ?? null,
    history: record.history ?? [],
  };

  // Employment from the raw actor item (never identity.company)
  const employment: MappedEmployment[] = [];
  for (const exp of raw?.experience ?? []) {
    const companyName = exp.companyName?.trim() || null;
    const companyId = exp.companyId != null && String(exp.companyId).trim() !== "" ? String(exp.companyId).trim() : null;
    if (!companyName && !companyId) {
      warnings.push(`experience_without_company:${exp.position ?? "?"}`);
      continue;
    }
    employment.push({
      title: exp.position?.trim() || null,
      company_name: companyName,
      linkedin_company_id: companyId,
      company_linkedin_url: exp.companyLinkedinUrl?.trim() || null,
      company_universal_name: extractCompanyUniversalName(exp.companyLinkedinUrl),
      start_month: formatActorDate(exp.startDate),
      end_month: isCurrentRole(exp) ? "Present" : formatActorDate(exp.endDate),
      is_current: isCurrentRole(exp),
      workplace_type: mapWorkplaceType(exp.workplaceType),
      employment_type: exp.employmentType?.trim() || null,
      location_raw: exp.location?.trim() || null,
    });
  }
  if (employment.length === 0) {
    warnings.push("no_employment_rows");
  }

  // Education
  const education: MappedEducation[] = [];
  for (const edu of raw?.education ?? []) {
    const schoolName = edu.schoolName?.trim();
    if (!schoolName) continue;
    education.push({
      school_name: schoolName,
      degree: edu.degree?.trim() || null,
      field_of_study: edu.fieldOfStudy?.trim() || null,
      start_year: actorYear(edu.startDate),
      end_year: actorYear(edu.endDate),
    });
  }

  // Profile location: prefer the actor's structured parse
  const parsed = raw?.location?.parsed;
  const profileLocation = parsed && (parsed.city || parsed.state || parsed.country)
    ? { city: parsed.city ?? null, state: parsed.state ?? null, country: parsed.country ?? null }
    : null;
  const profileLocationRaw = raw?.location?.linkedinText?.trim() || record.identity?.location?.trim() || null;

  // Photo: only LinkedIn CDN URLs are downloadable later
  const photo = raw?.photo?.trim() || null;
  const photoUrl = photo && photo.startsWith("https://media.licdn.com/") ? photo : null;

  return {
    name: record.identity.name.trim(),
    linkedin_url: canonicalUrl,
    public_identifier: raw?.publicIdentifier?.trim() || extractPublicIdentifier(canonicalUrl),
    non_vanity_url: nonVanity,
    headline: raw?.headline?.trim() || null,
    persona,
    review_note: record.pipeline?.review_reason?.trim() || null,
    verified_school: verifiedSchool,
    network_status: networkStatus,
    import_source: importSource,
    import_meta: importMeta,
    tags: (record.crm?.tags ?? []).map((t) => t.trim()).filter(Boolean),
    history_highlights: record.crm?.history_highlights?.trim() || null,
    profile_location_raw: profileLocationRaw,
    profile_location: profileLocation,
    photo_url: photoUrl,
    email,
    employment,
    education,
    warnings,
  };
}

function toNumberOrNull(v: string | number | null | undefined): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

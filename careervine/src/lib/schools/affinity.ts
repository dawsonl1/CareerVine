/**
 * School affinity — the single authority for "does this user's school change
 * what they see?" (CAR-213).
 *
 * Before this module the BYU test was copy-pasted in FIVE places:
 * isByuSchoolName() in company-queries.ts, isByuLikeSchool() in mcp/lib/
 * dossier.ts, and three inline SQL predicates in bundle_alumni_stats,
 * bundle_company_stats, and user_company_alumni_counts — each carrying a
 * comment claiming it "mirrors" one of the others. That is the duplication
 * that rots silently, so there is now exactly one TS implementation here and
 * exactly one SQL implementation (is_byu_family_school), held together by a
 * parity test that runs one shared fixture through both against real Postgres.
 * If you change the rule here, change it there, and the test will tell you if
 * you didn't.
 *
 * THE THREE AFFINITY STATES — the product has three, even though
 * hasAlumniAffinity() returns a boolean, and conflating the bottom two is how
 * the copy goes wrong:
 *
 *   BYU-family school     → full experience, exactly as before CAR-213
 *   Named, non-BYU school → filtered bundle, no highlighting, copy EXPLAINS why
 *   Blank                 → filtered bundle, no highlighting, copy INVITES a school
 *
 * Blank does NOT mean "not BYU". It means the user has claimed no school, so
 * the product has no basis for a school-based claim and makes none. The two
 * non-affinity states are identical in data and behaviour and differ only in
 * what the user is told, which is why callers that render copy must ask which
 * state they are in rather than just calling hasAlumniAffinity().
 *
 * Pure module — no DB access, no React, safe on the signup form (pre-session)
 * and inside the MCP server.
 */

import { UNIVERSITIES } from "./university-list";

// ── Name normalization ─────────────────────────────────────────────────

/**
 * Canonical form for comparing school names. MUST stay byte-identical in
 * behaviour to is_byu_family_school()'s normalization in SQL — the parity
 * test is what enforces that.
 *
 * Periods are stripped BEFORE the non-alphanumeric pass so "B.Y.U." collapses
 * to "byu" rather than to the three separate letters "b y u", which would
 * defeat the word-boundary match below.
 */
export function normalizeSchoolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/**
 * Free-text BYU-family test, for schools the user typed rather than picked.
 *
 * `\bbyu` — a word boundary BEFORE, deliberately none after. Neither of the
 * obvious alternatives is sufficient on its own, which a falsification pass
 * caught (CAR-213):
 *
 *   startsWith("byu")  misses "Marriott School at BYU"
 *   /\bbyu\b/          misses "BYUIdaho", typed without a separator
 *
 * `\bbyu` catches both, and still rejects the near-misses that matter:
 * "Bryant University" (b-r-y, no word starts with byu), "Young Harris College"
 * (has "young", not "brigham young"), and "Utah Valley University" (enormous
 * BYU overlap in real life, entirely separate alumni network). No English word
 * begins "byu", so the open right-hand side costs nothing.
 */
export function isByuFamilySchool(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = normalizeSchoolName(name);
  return n.includes("brigham young") || /\bbyu/.test(n);
}

// ── The user's own school ──────────────────────────────────────────────

const BY_NORMALIZED_NAME = new Map(
  UNIVERSITIES.map((u) => [normalizeSchoolName(u.name), u] as const),
);

/**
 * Resolve a stored users.university value to its curated entry. Returns null
 * for a blank field or for an escape-hatch school the user typed themselves.
 */
export function universityEntry(university: string | null | undefined) {
  if (!university) return null;
  return BY_NORMALIZED_NAME.get(normalizeSchoolName(university)) ?? null;
}

/**
 * The gate. False for a blank field BY DESIGN (Dawson, 2026-07-28): a user who
 * has claimed no school gets no alumni and no school highlighting, because the
 * product has nothing to base a claim on.
 *
 * Curated entries answer from their byuFamily flag — the qualifying set is a
 * product decision, not a string-matching accident. Only escape-hatch values
 * fall through to the normalizer.
 */
export function hasAlumniAffinity(university: string | null | undefined): boolean {
  const entry = universityEntry(university);
  if (entry) return entry.byuFamily === true;
  return isByuFamilySchool(university);
}

/**
 * How to name the user's school in a badge or count ("2 UCLA alumni").
 *
 * Null for an escape-hatch school, which has no curated abbreviation by
 * definition. Callers render "Alum" and drop the school from counts rather
 * than jamming a truncated free-text name into a chip.
 */
export function abbrFor(university: string | null | undefined): string | null {
  return universityEntry(university)?.abbr ?? null;
}

// ── Which bundle prospects a non-affinity subscriber receives ──────────

/** Personas that count as "in a product role". */
export const PRODUCT_PERSONAS: ReadonlySet<string> = new Set([
  "alum_product",
  "product_leader",
  "product_peer",
]);

/** Personas that survive the filter regardless of alumni status. A recruiter
 * at a target company hires no matter where you went to school. */
const RELEVANT_TO_EVERYONE: ReadonlySet<string> = new Set([
  ...PRODUCT_PERSONAS,
  "recruiter",
]);

/**
 * Is this prospect in the bundle ONLY because of the alumni angle?
 *
 * True → skipped for a subscriber with no alumni affinity. Against the live
 * bundle this selects exactly the 888 alum_other prospects and nothing else,
 * but the SEMANTIC rule is what ships, not `persona === "alum_other"`: that
 * equivalence is a property of today's data, and a future publish carrying a
 * new persona must not silently start dropping people.
 *
 * FAIL SAFE ON NULL PERSONA. An unclassified prospect is kept, never dropped.
 * Dropping is the destructive direction here — it withholds a real person from
 * a user's database — so an unknown persona must never be the reason for it.
 */
export function isAlumniOnlyProspect(p: {
  isAlumni: boolean;
  persona: string | null | undefined;
}): boolean {
  if (!p.isAlumni) return false;
  if (!p.persona) return false;
  return !RELEVANT_TO_EVERYONE.has(p.persona);
}

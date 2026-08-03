/**
 * Shared school-affinity fixture (CAR-213).
 *
 * ONE list, consumed by BOTH implementations of the rule:
 *   - the unit suite, against isByuFamilySchool() in TypeScript
 *   - the integration suite, against is_byu_family_school() in real Postgres
 *
 * That sharing is the entire point. Testing the TS and the SQL separately
 * proves each is self-consistent and says nothing about the failure that
 * actually happens, which is the two drifting apart — the exact rot that put
 * five copies of this rule in the codebase before CAR-213 consolidated them.
 *
 * Add a case here and both suites pick it up. Add it to only one and you have
 * rebuilt the problem.
 */

export type AffinityCase = {
  input: string;
  expected: boolean;
  /** Why this case is in the list — kept so nobody "simplifies" a trap away. */
  why: string;
};

export const SCHOOL_AFFINITY_CASES: readonly AffinityCase[] = [
  // ── The decision table (see the plan's "Who counts as BYU-family") ──
  { input: "Brigham Young University", expected: true, why: "canonical name" },
  { input: "Brigham Young University - Idaho", expected: true, why: "same alumni network" },
  { input: "Brigham Young University - Hawaii", expected: true, why: "same alumni network" },
  { input: "BYU Marriott School of Business", expected: true, why: "a college within BYU" },
  { input: "BYU-Pathway Worldwide", expected: true, why: "BYU-branded, shares the identity" },
  { input: "Ensign College", expected: false, why: "LDS-affiliated but not BYU, separate network" },
  { input: "Utah Valley University", expected: false, why: "THE tempting false positive: Provo, huge BYU overlap, unrelated alumni network" },

  // ── Format variants a real user or scraper produces ──
  { input: "BYU", expected: true, why: "bare abbreviation" },
  { input: "byu", expected: true, why: "lowercase" },
  { input: "  BYU  ", expected: true, why: "surrounding whitespace" },
  { input: "B.Y.U.", expected: true, why: "periods must strip BEFORE the word-boundary match, or this reads as three letters" },
  { input: "BYU-Idaho", expected: true, why: "hyphenated short form" },
  { input: "byu idaho", expected: true, why: "already-normalized form" },
  { input: "Brigham Young University–Idaho", expected: true, why: "en dash, not a hyphen" },
  { input: "The Brigham Young University", expected: true, why: "leading article stripped" },

  // ── Near misses that MUST stay false ──
  { input: "Bryant University", expected: false, why: "b-r-y: breaks a naive startsWith('byu')" },
  { input: "Young Harris College", expected: false, why: "contains 'young' but not 'brigham young'" },
  { input: "University of Utah", expected: false, why: "in-state rival, separate network" },
  { input: "Utah State University", expected: false, why: "separate network" },
  { input: "Stanford University", expected: false, why: "ordinary negative" },
  { input: "", expected: false, why: "empty string claims nothing" },
];

/**
 * Boundary rows for the bundle exclusion rule. These four ARE the product
 * decision: if any one flips, non-affinity users get the wrong database.
 */
export type ProspectCase = {
  isAlumni: boolean;
  persona: string | null;
  /** true = withheld from a subscriber with no alumni affinity */
  alumniOnly: boolean;
  why: string;
};

export const PROSPECT_FILTER_CASES: readonly ProspectCase[] = [
  { isAlumni: true, persona: "alum_product", alumniOnly: false, why: "an alum in a product role is a PM at a target company: useful to anyone" },
  { isAlumni: true, persona: "product_leader", alumniOnly: false, why: "product role" },
  { isAlumni: true, persona: "product_peer", alumniOnly: false, why: "product role" },
  { isAlumni: true, persona: "recruiter", alumniOnly: false, why: "a recruiter hires regardless of where you went to school" },
  { isAlumni: true, persona: "alum_other", alumniOnly: true, why: "in the bundle ONLY for the alumni angle: the 888" },
  { isAlumni: true, persona: null, alumniOnly: false, why: "FAIL SAFE: an unclassified prospect is never dropped" },
  { isAlumni: true, persona: "some_future_persona", alumniOnly: true, why: "an alum with an unrecognized non-product persona is still alumni-only" },
  { isAlumni: false, persona: "alum_other", alumniOnly: false, why: "not an alum: the persona alone never drops anyone" },
  { isAlumni: false, persona: null, alumniOnly: false, why: "non-alum, unclassified" },
];

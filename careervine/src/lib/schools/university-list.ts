/**
 * Curated university list (CAR-213).
 *
 * The single source for the school picker on signup, in Settings, and on the
 * contact forms. Lifted out of school-autocomplete.tsx so the data has one home
 * and the component has one job.
 *
 * `abbr` is what a person actually calls the school, not a derived acronym —
 * it is rendered directly in alum badges and counts ("2 UCLA alumni in
 * product"). Derivation does not work: "University of California, Berkeley" is
 * never "UCB", and "University of Michigan" has no single short form. So these
 * are looked up by hand, which is bounded because the list is bounded.
 *
 * `byuFamily` flags the schools that share the alumni network the curated
 * recruiting bundle was built around. It is a FLAG rather than a string match
 * because the flag is a product decision (see the plan's "Who counts as
 * BYU-family" table) and string matching is only the fallback for schools a
 * user types in themselves.
 *
 * Scope note: this is deliberately the previous ~110 entries plus the
 * BYU-family campuses and the Utah-region schools a BYU-adjacent user base is
 * most likely to attend. It is NOT an attempt at every US institution. The
 * escape hatch covers the tail, and the escape-hatch rate is the metric that
 * says when to widen this (see the plan's Success metrics).
 *
 * Pure data — no imports, no DB, safe to load pre-session on the signup form.
 */

export type University = {
  /** Canonical display name. This exact string is what lands in users.university. */
  name: string;
  /** How people refer to the school. Rendered in badges and counts. */
  abbr: string;
  /** Shares the alumni network the curated bundle was built around. */
  byuFamily?: true;
};

export const UNIVERSITIES: readonly University[] = [
  // ── BYU family ───────────────────────────────────────────────────────
  { name: "Brigham Young University", abbr: "BYU", byuFamily: true },
  { name: "Brigham Young University - Idaho", abbr: "BYU-I", byuFamily: true },
  { name: "Brigham Young University - Hawaii", abbr: "BYU-H", byuFamily: true },
  { name: "BYU Marriott School of Business", abbr: "BYU", byuFamily: true },
  { name: "BYU-Pathway Worldwide", abbr: "BYU-Pathway", byuFamily: true },

  // ── Utah region (highest-probability non-BYU schools for this user base) ──
  { name: "Utah State University", abbr: "USU" },
  { name: "Utah Valley University", abbr: "UVU" },
  { name: "Weber State University", abbr: "Weber State" },
  { name: "Southern Utah University", abbr: "SUU" },
  { name: "Westminster University", abbr: "Westminster" },
  { name: "Ensign College", abbr: "Ensign" },

  // ── Everything else, alphabetical ────────────────────────────────────
  { name: "Arizona State University", abbr: "ASU" },
  { name: "Auburn University", abbr: "Auburn" },
  { name: "Baylor University", abbr: "Baylor" },
  { name: "Boston College", abbr: "BC" },
  { name: "Boston University", abbr: "BU" },
  { name: "Brown University", abbr: "Brown" },
  { name: "California Institute of Technology", abbr: "Caltech" },
  { name: "Carnegie Mellon University", abbr: "CMU" },
  { name: "Case Western Reserve University", abbr: "Case Western" },
  { name: "Clemson University", abbr: "Clemson" },
  { name: "Colorado State University", abbr: "CSU" },
  { name: "Columbia University", abbr: "Columbia" },
  { name: "Cornell University", abbr: "Cornell" },
  { name: "Dartmouth College", abbr: "Dartmouth" },
  { name: "Drexel University", abbr: "Drexel" },
  { name: "Duke University", abbr: "Duke" },
  { name: "Emory University", abbr: "Emory" },
  { name: "Florida State University", abbr: "FSU" },
  { name: "Fordham University", abbr: "Fordham" },
  { name: "George Washington University", abbr: "GW" },
  { name: "Georgetown University", abbr: "Georgetown" },
  { name: "Georgia Institute of Technology", abbr: "Georgia Tech" },
  { name: "Harvard University", abbr: "Harvard" },
  { name: "Howard University", abbr: "Howard" },
  { name: "Indiana University Bloomington", abbr: "IU" },
  { name: "Iowa State University", abbr: "Iowa State" },
  { name: "Johns Hopkins University", abbr: "Johns Hopkins" },
  { name: "Lehigh University", abbr: "Lehigh" },
  { name: "Louisiana State University", abbr: "LSU" },
  { name: "Marquette University", abbr: "Marquette" },
  { name: "Massachusetts Institute of Technology", abbr: "MIT" },
  { name: "Michigan State University", abbr: "Michigan State" },
  { name: "New York University", abbr: "NYU" },
  { name: "North Carolina State University", abbr: "NC State" },
  { name: "Northeastern University", abbr: "Northeastern" },
  { name: "Northwestern University", abbr: "Northwestern" },
  { name: "Ohio State University", abbr: "Ohio State" },
  { name: "Oregon State University", abbr: "Oregon State" },
  { name: "Penn State University", abbr: "Penn State" },
  { name: "Pepperdine University", abbr: "Pepperdine" },
  { name: "Princeton University", abbr: "Princeton" },
  { name: "Purdue University", abbr: "Purdue" },
  { name: "Rice University", abbr: "Rice" },
  { name: "Rutgers University", abbr: "Rutgers" },
  { name: "Santa Clara University", abbr: "Santa Clara" },
  { name: "Southern Methodist University", abbr: "SMU" },
  { name: "Stanford University", abbr: "Stanford" },
  { name: "Syracuse University", abbr: "Syracuse" },
  { name: "Temple University", abbr: "Temple" },
  { name: "Texas A&M University", abbr: "Texas A&M" },
  { name: "Texas Tech University", abbr: "Texas Tech" },
  { name: "Tufts University", abbr: "Tufts" },
  { name: "Tulane University", abbr: "Tulane" },
  { name: "University of Alabama", abbr: "Alabama" },
  { name: "University of Arizona", abbr: "Arizona" },
  { name: "University of California, Berkeley", abbr: "Berkeley" },
  { name: "University of California, Davis", abbr: "UC Davis" },
  { name: "University of California, Irvine", abbr: "UC Irvine" },
  { name: "University of California, Los Angeles", abbr: "UCLA" },
  { name: "University of California, San Diego", abbr: "UC San Diego" },
  { name: "University of California, Santa Barbara", abbr: "UC Santa Barbara" },
  { name: "University of Central Florida", abbr: "UCF" },
  { name: "University of Chicago", abbr: "UChicago" },
  { name: "University of Cincinnati", abbr: "Cincinnati" },
  { name: "University of Colorado Boulder", abbr: "CU Boulder" },
  { name: "University of Connecticut", abbr: "UConn" },
  { name: "University of Delaware", abbr: "Delaware" },
  { name: "University of Denver", abbr: "Denver" },
  { name: "University of Florida", abbr: "Florida" },
  { name: "University of Georgia", abbr: "UGA" },
  { name: "University of Houston", abbr: "Houston" },
  { name: "University of Illinois Urbana-Champaign", abbr: "Illinois" },
  { name: "University of Iowa", abbr: "Iowa" },
  { name: "University of Kansas", abbr: "Kansas" },
  { name: "University of Kentucky", abbr: "Kentucky" },
  { name: "University of Maryland", abbr: "Maryland" },
  { name: "University of Massachusetts Amherst", abbr: "UMass" },
  { name: "University of Miami", abbr: "Miami" },
  { name: "University of Michigan", abbr: "Michigan" },
  { name: "University of Minnesota", abbr: "Minnesota" },
  { name: "University of Mississippi", abbr: "Ole Miss" },
  { name: "University of Missouri", abbr: "Mizzou" },
  { name: "University of Nebraska-Lincoln", abbr: "Nebraska" },
  { name: "University of North Carolina at Chapel Hill", abbr: "UNC" },
  { name: "University of Notre Dame", abbr: "Notre Dame" },
  { name: "University of Oklahoma", abbr: "Oklahoma" },
  { name: "University of Oregon", abbr: "Oregon" },
  { name: "University of Pennsylvania", abbr: "Penn" },
  { name: "University of Pittsburgh", abbr: "Pitt" },
  { name: "University of Rochester", abbr: "Rochester" },
  { name: "University of San Diego", abbr: "USD" },
  { name: "University of San Francisco", abbr: "USF" },
  { name: "University of South Carolina", abbr: "South Carolina" },
  { name: "University of South Florida", abbr: "USF" },
  { name: "University of Southern California", abbr: "USC" },
  { name: "University of Tennessee", abbr: "Tennessee" },
  { name: "University of Texas at Austin", abbr: "UT Austin" },
  { name: "University of Utah", abbr: "Utah" },
  { name: "University of Virginia", abbr: "UVA" },
  { name: "University of Washington", abbr: "UW" },
  { name: "University of Wisconsin-Madison", abbr: "Wisconsin" },
  { name: "Vanderbilt University", abbr: "Vanderbilt" },
  { name: "Villanova University", abbr: "Villanova" },
  { name: "Virginia Tech", abbr: "Virginia Tech" },
  { name: "Wake Forest University", abbr: "Wake Forest" },
  { name: "Washington State University", abbr: "Washington State" },
  { name: "Washington University in St. Louis", abbr: "WashU" },
  { name: "West Virginia University", abbr: "WVU" },
  { name: "Yale University", abbr: "Yale" },
];

/** Display names only, for the picker's suggestion list. */
export const UNIVERSITY_NAMES: readonly string[] = UNIVERSITIES.map((u) => u.name);

/**
 * School affinity rules (CAR-213) — the TypeScript half.
 *
 * The SQL half of the same rule is asserted against real Postgres in
 * src/__integration__/school-affinity-parity.itest.ts, driven by the SAME
 * fixture imported here. Neither suite is complete without the other: this one
 * proves the rule is right, that one proves the two implementations agree.
 */

import { describe, expect, it } from "vitest";
import {
  abbrFor,
  hasAlumniAffinity,
  isAlumniOnlyProspect,
  isByuFamilySchool,
  normalizeSchoolName,
  schoolsMatch,
  universityEntry,
} from "@/lib/schools/affinity";
import {
  PROSPECT_FILTER_CASES,
  SCHOOL_AFFINITY_CASES,
} from "@/lib/schools/affinity-fixtures";
import { UNIVERSITIES } from "@/lib/schools/university-list";

describe("isByuFamilySchool", () => {
  it.each(SCHOOL_AFFINITY_CASES)("$input → $expected ($why)", ({ input, expected }) => {
    expect(isByuFamilySchool(input)).toBe(expected);
  });

  it("treats absent values as claiming nothing", () => {
    expect(isByuFamilySchool(null)).toBe(false);
    expect(isByuFamilySchool(undefined)).toBe(false);
  });

  // Guards the fixture itself: a fixture of all-true or all-false cases would
  // let a stubbed implementation (`() => true`) pass every row above.
  it("fixture exercises both verdicts", () => {
    expect(SCHOOL_AFFINITY_CASES.some((c) => c.expected)).toBe(true);
    expect(SCHOOL_AFFINITY_CASES.some((c) => !c.expected)).toBe(true);
  });
});

describe("normalizeSchoolName", () => {
  it("strips periods before splitting, so an acronym survives", () => {
    // The specific reason B.Y.U. works: strip periods first and it is one
    // token "byu"; replace punctuation with spaces first and it is three
    // letters, which no word-boundary match on "byu" can ever catch.
    expect(normalizeSchoolName("B.Y.U.")).toBe("byu");
  });

  it("collapses punctuation, case, and whitespace to one form", () => {
    expect(normalizeSchoolName("  Brigham Young University - Idaho  ")).toBe(
      "brigham young university idaho",
    );
    expect(normalizeSchoolName("Brigham Young University–Idaho")).toBe(
      "brigham young university idaho",
    );
  });

  it("drops a leading article", () => {
    expect(normalizeSchoolName("The Ohio State University")).toBe("ohio state university");
  });
});

describe("hasAlumniAffinity", () => {
  it("is false for a blank field, by design", () => {
    // Dawson, 2026-07-28: blank does not mean "not BYU", it means the user has
    // claimed no school — so the product has no basis for a school claim and
    // makes none. This is the single most load-bearing line in the feature:
    // flip it and every user who skips an optional field gets BYU badges on
    // strangers and a first email claiming a school they never attended.
    expect(hasAlumniAffinity(null)).toBe(false);
    expect(hasAlumniAffinity(undefined)).toBe(false);
    expect(hasAlumniAffinity("")).toBe(false);
    expect(hasAlumniAffinity("   ")).toBe(false);
  });

  it("answers curated entries from their flag, not from string matching", () => {
    expect(hasAlumniAffinity("Brigham Young University")).toBe(true);
    expect(hasAlumniAffinity("BYU Marriott School of Business")).toBe(true);
    expect(hasAlumniAffinity("Utah Valley University")).toBe(false);
    expect(hasAlumniAffinity("Ensign College")).toBe(false);
  });

  it("falls through to the normalizer for escape-hatch schools", () => {
    // Not on the curated list, so only the free-text rule can catch it.
    expect(universityEntry("BYU Law School")).toBeNull();
    expect(hasAlumniAffinity("BYU Law School")).toBe(true);
    expect(hasAlumniAffinity("Some Community College")).toBe(false);
  });
});

describe("schoolsMatch — does a CONTACT count as your alum", () => {
  it("is false for EVERY contact when the user has no school", () => {
    // The dangerous direction. A truthy fallback here badges every contact in
    // the database as the user's alum — for a user who never named a school,
    // which is the single most common state after this ships.
    for (const contact of ["Brigham Young University", "Stanford University", "Utah State University", ""]) {
      expect(schoolsMatch(contact, null)).toBe(false);
      expect(schoolsMatch(contact, "")).toBe(false);
      expect(schoolsMatch(contact, undefined)).toBe(false);
    }
  });

  it("is false when the CONTACT has no school", () => {
    expect(schoolsMatch(null, "Brigham Young University")).toBe(false);
    expect(schoolsMatch("", "Brigham Young University")).toBe(false);
  });

  it("matches the whole BYU family for a BYU user", () => {
    // Pre-CAR-213 behaviour that must not regress: a BYU-Idaho contact is a
    // warm door for a Provo student.
    expect(schoolsMatch("Brigham Young University - Idaho", "Brigham Young University")).toBe(true);
    expect(schoolsMatch("BYU Marriott School of Business", "BYU")).toBe(true);
  });

  it("matches only the exact school for everyone else", () => {
    // No defined "family" for an arbitrary institution, and inventing one
    // would badge strangers.
    expect(schoolsMatch("Utah State University", "Utah State University")).toBe(true);
    expect(schoolsMatch("utah state university", "Utah State University")).toBe(true);
    expect(schoolsMatch("University of Utah", "Utah State University")).toBe(false);
    expect(schoolsMatch("Brigham Young University", "Utah State University")).toBe(false);
  });

  it("does not make a BYU contact an alum of a non-BYU user", () => {
    // The specific wrong badge: a USU user importing a BYU alum must not be
    // told that person is their alum.
    expect(schoolsMatch("Brigham Young University", "Utah State University")).toBe(false);
  });
});

describe("abbrFor", () => {
  it("names curated schools the way people say them", () => {
    expect(abbrFor("Brigham Young University")).toBe("BYU");
    expect(abbrFor("Brigham Young University - Idaho")).toBe("BYU-I");
    expect(abbrFor("University of California, Los Angeles")).toBe("UCLA");
    expect(abbrFor("Utah State University")).toBe("USU");
  });

  it("returns null for escape-hatch and blank schools, so callers fall back to 'Alum'", () => {
    expect(abbrFor("Some Community College")).toBeNull();
    expect(abbrFor(null)).toBeNull();
    expect(abbrFor("")).toBeNull();
  });
});

describe("university list integrity", () => {
  it("every entry has a non-empty abbreviation", () => {
    // The badge renders `abbr` directly. A blank one ships an empty chip.
    const missing = UNIVERSITIES.filter((u) => !u.abbr.trim());
    expect(missing).toEqual([]);
  });

  it("has no duplicate names", () => {
    const names = UNIVERSITIES.map((u) => normalizeSchoolName(u.name));
    expect(names.length).toBe(new Set(names).size);
  });

  it("flags exactly the BYU-family entries, and the flag agrees with the normalizer", () => {
    // Belt and braces: the flag is authoritative, but a curated entry whose
    // flag disagrees with the free-text rule means a user picking it from the
    // list and a user typing it get different products.
    for (const u of UNIVERSITIES) {
      expect({ name: u.name, affinity: u.byuFamily === true }).toEqual({
        name: u.name,
        affinity: isByuFamilySchool(u.name),
      });
    }
  });
});

describe("isAlumniOnlyProspect — the four rows that ARE the exclusion rule", () => {
  it.each(PROSPECT_FILTER_CASES)(
    "alumni=$isAlumni persona=$persona → alumniOnly=$alumniOnly ($why)",
    ({ isAlumni, persona, alumniOnly }) => {
      expect(isAlumniOnlyProspect({ isAlumni, persona })).toBe(alumniOnly);
    },
  );

  it("never drops a prospect for an unknown persona alone", () => {
    // Dropping withholds a real person from a user's database, so it is the
    // destructive direction. An unclassified prospect must fail toward keeping.
    expect(isAlumniOnlyProspect({ isAlumni: true, persona: null })).toBe(false);
    expect(isAlumniOnlyProspect({ isAlumni: true, persona: undefined })).toBe(false);
    expect(isAlumniOnlyProspect({ isAlumni: true, persona: "" })).toBe(false);
  });

  it("fixture exercises both verdicts", () => {
    expect(PROSPECT_FILTER_CASES.some((c) => c.alumniOnly)).toBe(true);
    expect(PROSPECT_FILTER_CASES.some((c) => !c.alumniOnly)).toBe(true);
  });
});

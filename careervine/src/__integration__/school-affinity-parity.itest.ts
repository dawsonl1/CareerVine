/**
 * TS ↔ SQL parity for the school-affinity rules (CAR-213).
 *
 * The CareerVine BYU test used to exist in FIVE copies — two TS helpers and
 * three inline SQL predicates, each commented as "mirrors" one of the others,
 * and no mechanism anywhere to notice when one changed. CAR-213 collapsed that
 * to one implementation per language. THIS FILE is the thing that keeps it at
 * one: it runs a SHARED fixture through both against real Postgres and asserts
 * they agree row by row.
 *
 * Why shared rather than two suites: testing the TS against its own
 * expectations and the SQL against its own expectations proves each is
 * self-consistent and says nothing whatsoever about the failure that actually
 * happens, which is the two drifting apart. Both halves must be driven by one
 * list, or this file is theatre.
 *
 * If you change a rule in affinity.ts, change it in
 * supabase/migrations/*_car213_school_affinity_sql.sql too. This test is how
 * you find out that you didn't.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { pgPool } from "./helpers/stack";
import {
  isAlumniOnlyProspect,
  isByuFamilySchool,
  normalizeSchoolName,
} from "@/lib/schools/affinity";
import {
  PROSPECT_FILTER_CASES,
  SCHOOL_AFFINITY_CASES,
} from "@/lib/schools/affinity-fixtures";
import { UNIVERSITIES } from "@/lib/schools/university-list";

let pool: Pool;

beforeAll(() => {
  pool = pgPool();
});

afterAll(async () => {
  await pool.end();
});

describe("is_byu_family_school() agrees with isByuFamilySchool()", () => {
  it("returns the identical verdict for every fixture case", async () => {
    const inputs = SCHOOL_AFFINITY_CASES.map((c) => c.input);
    const { rows } = await pool.query<{ input: string; sql_verdict: boolean }>(
      `SELECT t.input, public.is_byu_family_school(t.input) AS sql_verdict
         FROM unnest($1::text[]) AS t(input)`,
      [inputs],
    );

    // Compared as one object rather than in a loop so a failure prints EVERY
    // disagreement at once — the whole point is spotting drift, and drift
    // usually moves more than a single row.
    const fromSql = Object.fromEntries(rows.map((r) => [r.input, r.sql_verdict]));
    const fromTs = Object.fromEntries(
      SCHOOL_AFFINITY_CASES.map((c) => [c.input, isByuFamilySchool(c.input)]),
    );
    expect(fromSql).toEqual(fromTs);
  });

  it("both engines match the fixture's own expectations", async () => {
    // Parity alone is satisfied by two implementations that are wrong in the
    // SAME way. This pins both to the decision table in the plan.
    const inputs = SCHOOL_AFFINITY_CASES.map((c) => c.input);
    const { rows } = await pool.query<{ input: string; sql_verdict: boolean }>(
      `SELECT t.input, public.is_byu_family_school(t.input) AS sql_verdict
         FROM unnest($1::text[]) AS t(input)`,
      [inputs],
    );
    const fromSql = new Map(rows.map((r) => [r.input, r.sql_verdict]));
    const expected = Object.fromEntries(SCHOOL_AFFINITY_CASES.map((c) => [c.input, c.expected]));

    expect(Object.fromEntries([...fromSql])).toEqual(expected);
    expect(
      Object.fromEntries(SCHOOL_AFFINITY_CASES.map((c) => [c.input, isByuFamilySchool(c.input)])),
    ).toEqual(expected);
  });

  it("agrees that NULL claims nothing", async () => {
    const { rows } = await pool.query<{ v: boolean }>(
      "SELECT public.is_byu_family_school(NULL) AS v",
    );
    expect(rows[0].v).toBe(false);
    expect(isByuFamilySchool(null)).toBe(false);
  });
});

describe("normalize_school_name() agrees with normalizeSchoolName()", () => {
  it("produces the identical canonical form for every fixture input", async () => {
    // Normalization is where the two could drift invisibly: a verdict can
    // agree by luck while the underlying forms differ, and the next rule
    // change then lands on different inputs in each language.
    const inputs = SCHOOL_AFFINITY_CASES.map((c) => c.input);
    const { rows } = await pool.query<{ input: string; normalized: string }>(
      `SELECT t.input, public.normalize_school_name(t.input) AS normalized
         FROM unnest($1::text[]) AS t(input)`,
      [inputs],
    );
    const fromSql = Object.fromEntries(rows.map((r) => [r.input, r.normalized]));
    const fromTs = Object.fromEntries(
      SCHOOL_AFFINITY_CASES.map((c) => [c.input, normalizeSchoolName(c.input)]),
    );
    expect(fromSql).toEqual(fromTs);
  });

  it("agrees on every curated school name", async () => {
    const names = UNIVERSITIES.map((u) => u.name);
    const { rows } = await pool.query<{ input: string; normalized: string }>(
      `SELECT t.input, public.normalize_school_name(t.input) AS normalized
         FROM unnest($1::text[]) AS t(input)`,
      [names],
    );
    const fromSql = Object.fromEntries(rows.map((r) => [r.input, r.normalized]));
    const fromTs = Object.fromEntries(names.map((n) => [n, normalizeSchoolName(n)]));
    expect(fromSql).toEqual(fromTs);
  });
});

describe("is_alumni_only_prospect() agrees with isAlumniOnlyProspect()", () => {
  it("returns the identical verdict for every boundary case", async () => {
    const { rows } = await pool.query<{
      is_alumni: boolean;
      persona: string | null;
      sql_verdict: boolean;
    }>(
      `SELECT t.is_alumni, t.persona,
              public.is_alumni_only_prospect(t.is_alumni, t.persona) AS sql_verdict
         FROM unnest($1::boolean[], $2::text[]) AS t(is_alumni, persona)`,
      [
        PROSPECT_FILTER_CASES.map((c) => c.isAlumni),
        PROSPECT_FILTER_CASES.map((c) => c.persona),
      ],
    );

    const key = (a: boolean, p: string | null) => `${a}/${p ?? "NULL"}`;
    const fromSql = Object.fromEntries(rows.map((r) => [key(r.is_alumni, r.persona), r.sql_verdict]));
    const fromTs = Object.fromEntries(
      PROSPECT_FILTER_CASES.map((c) => [
        key(c.isAlumni, c.persona),
        isAlumniOnlyProspect({ isAlumni: c.isAlumni, persona: c.persona }),
      ]),
    );
    const expected = Object.fromEntries(
      PROSPECT_FILTER_CASES.map((c) => [key(c.isAlumni, c.persona), c.alumniOnly]),
    );

    expect(fromSql).toEqual(fromTs);
    expect(fromSql).toEqual(expected);
  });

  it("both engines fail SAFE on a null persona", async () => {
    // The single most consequential row: dropping withholds a real person
    // from a user's database, so an unclassified prospect must be KEPT.
    const { rows } = await pool.query<{ v: boolean }>(
      "SELECT public.is_alumni_only_prospect(true, NULL) AS v",
    );
    expect(rows[0].v).toBe(false);
    expect(isAlumniOnlyProspect({ isAlumni: true, persona: null })).toBe(false);
  });
});

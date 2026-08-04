import { describe, expect, it } from "vitest";
import {
  parseExperienceMonth,
  primaryCurrentRole,
  sortEducation,
  sortExperiences,
} from "@/lib/experience-order";

type Row = {
  label: string;
  is_current?: boolean | null;
  start_month?: string | null;
  end_month?: string | null;
};
const row = (label: string, start: string | null, end: string | null, current = false): Row => ({
  label,
  start_month: start,
  end_month: end,
  is_current: current,
});
const labels = (rows: Row[]) => rows.map((r) => r.label);

describe("parseExperienceMonth", () => {
  // The shapes a survey of 1000 production rows actually found.
  it("parses the documented 'Mon YYYY' shape", () => {
    expect(parseExperienceMonth("Jan 2023")).toBe(202301);
    expect(parseExperienceMonth("Dec 2023")).toBe(202312);
    expect(parseExperienceMonth("September 2019")).toBe(201909);
    expect(parseExperienceMonth("sept. 2019")).toBe(201909);
    expect(parseExperienceMonth("  JUL 2014  ")).toBe(201407);
  });

  it("parses a bare year as that year with no month", () => {
    expect(parseExperienceMonth("2017")).toBe(201700);
  });

  it("ranks a dated month above a bare year in the same year", () => {
    expect(parseExperienceMonth("Jun 2023")).toBeGreaterThan(parseExperienceMonth("2023")!);
  });

  it("parses numeric shapes in either order", () => {
    expect(parseExperienceMonth("2023-01")).toBe(202301);
    expect(parseExperienceMonth("2023/1")).toBe(202301);
    expect(parseExperienceMonth("01/2023")).toBe(202301);
    expect(parseExperienceMonth("7-2014")).toBe(201407);
  });

  it("returns null for anything with no 4-digit year", () => {
    // All three are real production values from user-typed rows.
    expect(parseExperienceMonth("Jul")).toBeNull();
    expect(parseExperienceMonth("June")).toBeNull();
    expect(parseExperienceMonth("December 202")).toBeNull();
  });

  it("returns null for 'Present' and for empty input", () => {
    expect(parseExperienceMonth("Present")).toBeNull();
    expect(parseExperienceMonth("present")).toBeNull();
    expect(parseExperienceMonth("")).toBeNull();
    expect(parseExperienceMonth("   ")).toBeNull();
    expect(parseExperienceMonth(null)).toBeNull();
    expect(parseExperienceMonth(undefined)).toBeNull();
  });

  it("ignores an out-of-range numeric month rather than trusting it", () => {
    // 13 is not a month; the year still parses.
    expect(parseExperienceMonth("2023-13")).toBe(202300);
  });

  it("reads a range typed into one field as its start", () => {
    expect(parseExperienceMonth("2021-2023")).toBe(202100);
    expect(parseExperienceMonth("Jan 2023 - Present")).toBe(202301);
  });

  it("does not mistake a non-month word for a month", () => {
    expect(parseExperienceMonth("Summer 2019")).toBe(201900);
    expect(parseExperienceMonth("Winter 2019")).toBe(201900);
    expect(parseExperienceMonth("construct 2020")).toBe(202000);
  });
});

describe("sortExperiences", () => {
  it("puts current roles first, then newest start first", () => {
    const sorted = sortExperiences([
      row("old", "Jan 2012", "Dec 2014"),
      row("newest current", "Mar 2021", "Present", true),
      row("recent past", "Jan 2018", "Jun 2020"),
      row("older current", "Jul 2014", "Present", true),
    ]);
    expect(labels(sorted)).toEqual(["newest current", "older current", "recent past", "old"]);
  });

  it("orders by real chronology, not by month name", () => {
    // The comparator this replaces used localeCompare on "Mon YYYY", which
    // ordered these exactly backwards: Mar 2021, Jul 2021, Jul 2014, Jan 2018.
    const sorted = sortExperiences([
      row("a", "Jul 2014", "Present", true),
      row("b", "Jan 2018", "Present", true),
      row("c", "Mar 2021", "Present", true),
      row("d", "Jul 2021", "Present", true),
    ]);
    expect(labels(sorted)).toEqual(["d", "c", "b", "a"]);
  });

  it("ranks a bare year against a dated month correctly", () => {
    const sorted = sortExperiences([
      row("2017 board seat", "2017", "Present", true),
      row("2023 board seat", "2023", "Present", true),
      row("mid-2021", "Jul 2021", "Present", true),
    ]);
    expect(labels(sorted)).toEqual(["2023 board seat", "mid-2021", "2017 board seat"]);
  });

  it("falls back to the end month when the start is unusable", () => {
    const sorted = sortExperiences([
      row("dated start", "Jan 2015", "Dec 2016"),
      row("month with no year", "Jul", "Aug 2022"),
    ]);
    expect(labels(sorted)).toEqual(["month with no year", "dated start"]);
  });

  it("puts fully undated rows last within their group", () => {
    const sorted = sortExperiences([
      row("undated past", null, null),
      row("dated past", "Jan 2010", "Jan 2012"),
      row("undated current", null, null, true),
    ]);
    expect(labels(sorted)).toEqual(["undated current", "dated past", "undated past"]);
  });

  it("breaks equal starts on the end month, newest first", () => {
    const sorted = sortExperiences([
      row("ended sooner", "Jan 2015", "Jan 2016"),
      row("ended later", "Jan 2015", "Jan 2019"),
    ]);
    expect(labels(sorted)).toEqual(["ended later", "ended sooner"]);
  });

  it("is stable on fully equal rows, so the output depends only on the input", () => {
    const equal = [row("first", "Jan 2015", "Jan 2016"), row("second", "Jan 2015", "Jan 2016")];
    expect(labels(sortExperiences(equal))).toEqual(["first", "second"]);
    expect(labels(sortExperiences([...equal].reverse()))).toEqual(["second", "first"]);
  });

  it("does not mutate its input", () => {
    const input = [row("a", "Jan 2010", "Jan 2012"), row("b", "Jan 2020", "Present", true)];
    const snapshot = labels(input);
    sortExperiences(input);
    expect(labels(input)).toEqual(snapshot);
  });

  it("treats a null is_current as not current", () => {
    const sorted = sortExperiences([
      { label: "null current", is_current: null, start_month: "Jan 2020", end_month: null },
      { label: "real current", is_current: true, start_month: "Jan 2010", end_month: "Present" },
    ]);
    expect(labels(sorted)).toEqual(["real current", "null current"]);
  });

  it("handles an empty list", () => {
    expect(sortExperiences([])).toEqual([]);
  });

  it("orders the real production payload that motivated this (contact 114)", () => {
    // Straight from the join, in the company_id order PostgREST returned.
    const asStored = [
      row("Neighbor board seat", "2017", "Present", true),
      row("Qualtrics marketing", "2012", "2014"),
      row("Album VC general partner", "Jul 2014", "Present", true),
      row("Innovasis operations", "Aug 2004", "Aug 2007"),
      row("Elektrik board seat", "Mar 2021", "Present", true),
    ];
    expect(labels(sortExperiences(asStored))).toEqual([
      "Elektrik board seat",
      "Neighbor board seat",
      "Album VC general partner",
      "Qualtrics marketing",
      "Innovasis operations",
    ]);
  });
});

describe("primaryCurrentRole", () => {
  it("returns the newest-starting current role, not the first in the array", () => {
    const rows = [
      row("old board seat", "2017", "Present", true),
      row("newest role", "Jan 2022", "Present", true),
      row("past role", "Jan 2000", "Jan 2005"),
    ];
    expect(primaryCurrentRole(rows)?.label).toBe("newest role");
  });

  it("returns undefined when nothing is current", () => {
    expect(primaryCurrentRole([row("past", "Jan 2000", "Jan 2005")])).toBeUndefined();
    expect(primaryCurrentRole([])).toBeUndefined();
  });
});

describe("sortEducation", () => {
  const edu = (label: string, start: number | null, end: number | null) => ({
    label,
    start_year: start,
    end_year: end,
  });

  it("orders newest end year first", () => {
    const sorted = sortEducation([edu("BS", 2014, 2018), edu("MBA", 2020, 2022)]);
    expect(sorted.map((e) => e.label)).toEqual(["MBA", "BS"]);
  });

  it("falls back to start year when the end year is missing", () => {
    const sorted = sortEducation([edu("older", 2010, null), edu("newer", 2019, null)]);
    expect(sorted.map((e) => e.label)).toEqual(["newer", "older"]);
  });

  it("breaks an end-year tie on start year, newest first", () => {
    const sorted = sortEducation([edu("four year", 2014, 2018), edu("two year", 2016, 2018)]);
    expect(sorted.map((e) => e.label)).toEqual(["two year", "four year"]);
  });

  it("puts undated rows last and keeps their relative order", () => {
    const sorted = sortEducation([
      edu("undated a", null, null),
      edu("dated", 2014, 2018),
      edu("undated b", null, null),
    ]);
    expect(sorted.map((e) => e.label)).toEqual(["dated", "undated a", "undated b"]);
  });

  it("does not mutate its input", () => {
    const input = [edu("a", 2000, 2004), edu("b", 2018, 2022)];
    sortEducation(input);
    expect(input.map((e) => e.label)).toEqual(["a", "b"]);
  });
});

import { describe, it, expect } from "vitest";
import { employmentKey, employmentRowKey, computeEmploymentMerge } from "@/lib/scrape-merge";

/**
 * CAR-261. `contact_companies` shipped with a unique index keyed on `start_date`,
 * a column NULL on all 88,204 production rows, so Postgres's NULLs-are-distinct
 * rule meant it never rejected anything. 70 duplicate rows accumulated across
 * every account in the system.
 *
 * The replacement index keys on (contact_id, company_id, title, start_month,
 * end_month) NULLS NOT DISTINCT, and `employmentRowKey` is its in-code mirror.
 * These pin the one distinction that makes the two keys different, because
 * getting it wrong destroys real employment history rather than duplicates.
 */

const base = {
  company_id: 9,
  title: "Software Development Engineer Intern",
  start_month: "May 2015",
  end_month: "Aug 2015",
  is_current: false,
  location_id: null,
  location_source: null,
  location_raw: null,
  workplace_type: null,
  employment_type: null,
};

describe("employmentRowKey vs employmentKey", () => {
  it("separates two stints that differ only in end_month", () => {
    // Cody Wang's two AWS internships, measured in production: same company,
    // same title, same start month, ending Aug 2015 and Aug 2016.
    const a = { ...base, end_month: "Aug 2015" };
    const b = { ...base, end_month: "Aug 2016" };

    expect(employmentRowKey(a)).not.toBe(employmentRowKey(b));
    // The matching key deliberately conflates them, which is why it must never
    // be used to decide duplication.
    expect(employmentKey(a)).toBe(employmentKey(b));
  });

  it("treats an exact repeat as the same row", () => {
    expect(employmentRowKey({ ...base })).toBe(employmentRowKey({ ...base }));
  });

  it("folds case and whitespace, so it catches strictly more than the index", () => {
    const messy = { ...base, title: "  SOFTWARE Development Engineer Intern ", end_month: "AUG 2015" };
    expect(employmentRowKey(messy)).toBe(employmentRowKey(base));
  });

  it("treats all-null optional columns as one key, matching NULLS NOT DISTINCT", () => {
    const nulls = { ...base, title: null, start_month: null, end_month: null };
    expect(employmentRowKey(nulls)).toBe(employmentRowKey({ ...nulls }));
    // and still distinct from a row that carries values
    expect(employmentRowKey(nulls)).not.toBe(employmentRowKey(base));
  });
});

describe("computeEmploymentMerge incoming dedupe", () => {
  it("collapses an exact repeat in the payload", () => {
    const plan = computeEmploymentMerge([], [{ ...base }, { ...base }], "2026-08-07T00:00:00Z");
    expect(plan.inserts).toHaveLength(1);
  });

  it("keeps two stints that differ only in end_month", () => {
    // Before CAR-261 the incoming dedupe used the narrow matching key, so the
    // second internship was silently dropped from the payload and never stored.
    const plan = computeEmploymentMerge(
      [],
      [
        { ...base, end_month: "Aug 2015" },
        { ...base, end_month: "Aug 2016" },
      ],
      "2026-08-07T00:00:00Z",
    );
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts.map((i) => i.end_month).sort()).toEqual(["Aug 2015", "Aug 2016"]);
  });

  it("still matches an existing row whose end_month drifted, rather than inserting", () => {
    // The reason the MATCHING key excludes end_month: someone leaving turns
    // "Present" into a date, and that has to update the row, not add a job.
    const plan = computeEmploymentMerge(
      [
        {
          id: 1,
          company_id: base.company_id,
          title: base.title,
          start_month: base.start_month,
          end_month: "Present",
          is_current: true,
          location_id: null,
          location_source: null,
          location_raw: null,
          workplace_type: null,
          employment_type: null,
          source: "scraped",
        },
      ],
      [{ ...base, end_month: "Aug 2015", is_current: false }],
      "2026-08-07T00:00:00Z",
    );
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].fields.end_month).toBe("Aug 2015");
  });
});

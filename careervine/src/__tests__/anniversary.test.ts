import { describe, it, expect } from "vitest";
import {
  parseStartMonth,
  computeAnniversaryEventsForContact,
  computeAnniversaryEvents,
  type AnniversaryContact,
} from "@/lib/change-events/anniversary";

describe("parseStartMonth", () => {
  it("parses 'Mon YYYY'", () => {
    expect(parseStartMonth("Mar 2021")).toEqual({ month: 2, year: 2021 });
  });

  it("parses full month names and is case-insensitive", () => {
    expect(parseStartMonth("september 2019")).toEqual({ month: 8, year: 2019 });
    expect(parseStartMonth("DECEMBER 2020")).toEqual({ month: 11, year: 2020 });
  });

  it("tolerates punctuation and comma ordering", () => {
    expect(parseStartMonth("Mar. 2021")).toEqual({ month: 2, year: 2021 });
    expect(parseStartMonth("March, 2021")).toEqual({ month: 2, year: 2021 });
    expect(parseStartMonth("2021 Mar")).toEqual({ month: 2, year: 2021 });
  });

  it("returns null for bare years (no month component)", () => {
    expect(parseStartMonth("2021")).toBeNull();
  });

  it("returns null for Present, empty, and garbage", () => {
    expect(parseStartMonth("Present")).toBeNull();
    expect(parseStartMonth("present")).toBeNull();
    expect(parseStartMonth("")).toBeNull();
    expect(parseStartMonth("   ")).toBeNull();
    expect(parseStartMonth(null)).toBeNull();
    expect(parseStartMonth(undefined)).toBeNull();
    expect(parseStartMonth("sometime last year")).toBeNull();
  });

  it("rejects implausible years", () => {
    expect(parseStartMonth("Mar 1850")).toBeNull();
    expect(parseStartMonth("Mar 3000")).toBeNull();
  });
});

function contact(overrides: Partial<AnniversaryContact> = {}): AnniversaryContact {
  return {
    id: 1,
    name: "Sarah Chen",
    photo_url: null,
    industry: null,
    employment: [],
    ...overrides,
  };
}

const MARCH_2026 = new Date("2026-03-15T12:00:00Z");

describe("computeAnniversaryEventsForContact", () => {
  it("fires a whole-year anniversary in the anniversary month", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "Mar 2021", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      contactId: 1,
      type: "anniversary",
      tier: 2,
      dedupeKey: "anniversary:1:10:2026",
    });
    expect(events[0].headline).toBe("Sarah Chen hits 5 years at Domo this month");
    expect(events[0].evidence).toContain("5th work anniversary");
  });

  it("does not fire outside the anniversary month", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "Jul 2021", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(0);
  });

  it("does not fire before a full year has elapsed", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "Mar 2026", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(0);
  });

  it("ignores non-current roles", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "Mar 2021", is_current: false }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(0);
  });

  it("skips rows without a parseable month", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "2021", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(0);
  });

  it("skips rows with no company_id (can't build a stable dedupe key)", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: null, company_name: "Domo", start_month: "Mar 2021", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events).toHaveLength(0);
  });

  it("emits one event per qualifying concurrent current role", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [
          { company_id: 10, company_name: "Domo", start_month: "Mar 2021", is_current: true },
          { company_id: 20, company_name: "BYU", start_month: "Mar 2023", is_current: true },
          { company_id: 30, company_name: "Old Co", start_month: "Mar 2015", is_current: false },
        ],
      }),
      MARCH_2026,
    );
    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "anniversary:1:10:2026",
      "anniversary:1:20:2026",
    ]);
  });

  it("handles singular '1 year' phrasing", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: "Domo", start_month: "Mar 2025", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events[0].headline).toBe("Sarah Chen hits 1 year at Domo this month");
  });

  it("falls back gracefully when company_name is missing", () => {
    const events = computeAnniversaryEventsForContact(
      contact({
        employment: [{ company_id: 10, company_name: null, start_month: "Mar 2021", is_current: true }],
      }),
      MARCH_2026,
    );
    expect(events[0].headline).toContain("their company");
  });
});

describe("computeAnniversaryEvents", () => {
  it("flattens across contacts", () => {
    const events = computeAnniversaryEvents(
      [
        contact({ id: 1, employment: [{ company_id: 10, company_name: "Domo", start_month: "Mar 2021", is_current: true }] }),
        contact({ id: 2, name: "Bob", employment: [{ company_id: 20, company_name: "Qualtrics", start_month: "Mar 2020", is_current: true }] }),
        contact({ id: 3, name: "Nope", employment: [{ company_id: 30, company_name: "X", start_month: "Jul 2020", is_current: true }] }),
      ],
      MARCH_2026,
    );
    expect(events.map((e) => e.contactId).sort()).toEqual([1, 2]);
  });
});

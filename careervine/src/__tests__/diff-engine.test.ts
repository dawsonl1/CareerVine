import { describe, it, expect } from "vitest";
import {
  computeDiff,
  buildSnapshot,
  type DiffInput,
  type ScrapeSnapshot,
  type SnapshotEmployment,
} from "@/lib/change-events/diff-engine";

const SCRAPED_AT = "2026-07-09T12:00:00.000Z";

function snap(overrides: Partial<ScrapeSnapshot> = {}): ScrapeSnapshot {
  return {
    headline: null,
    location_text: null,
    open_to_work: null,
    hiring: null,
    has_photo: false,
    certifications: [],
    employment: [],
    ...overrides,
  };
}

function emp(overrides: Partial<SnapshotEmployment> = {}): SnapshotEmployment {
  return {
    company_id: 10,
    linkedin_company_id: "111",
    company_name: "Domo",
    title: "PM",
    start_month: "Jan 2023",
    is_current: true,
    ...overrides,
  };
}

function input(overrides: Partial<DiffInput> = {}): DiffInput {
  return {
    contactId: 7,
    contactName: "Sarah Chen",
    scrapedAt: SCRAPED_AT,
    existingEmployment: [{ company_id: 10, title: "PM", start_month: "Jan 2023", is_current: true }],
    companyLinkedinIds: new Map([[10, "111"], [20, "222"]]),
    prevSnapshot: snap(),
    nextSnapshot: snap({ employment: [emp()] }),
    ...overrides,
  };
}

describe("computeDiff — company change", () => {
  it("fires Tier-1 company_change for a new current company with a differing LinkedIn id", () => {
    const events = computeDiff(
      input({
        nextSnapshot: snap({
          employment: [emp({ company_id: 20, linkedin_company_id: "222", company_name: "Qualtrics", title: "Senior PM", start_month: "Jun 2026" })],
        }),
      }),
    );
    const ce = events.find((e) => e.type === "company_change");
    expect(ce).toBeDefined();
    expect(ce!.tier).toBe(1);
    expect(ce!.dedupeKey).toBe("company_change:7:222");
    expect(ce!.headline).toBe("Sarah Chen just joined Qualtrics as Senior PM");
  });

  it("false-positive guard: no event when the new company lacks a LinkedIn id", () => {
    const events = computeDiff(
      input({
        nextSnapshot: snap({
          employment: [emp({ company_id: 99, linkedin_company_id: null, company_name: "Domo, Inc." })],
        }),
      }),
    );
    expect(events.filter((e) => e.type === "company_change")).toHaveLength(0);
  });

  it("false-positive guard: no event when the new id matches a prior current company's id", () => {
    // Same real company resolved to a different row but same LinkedIn id.
    const events = computeDiff(
      input({
        nextSnapshot: snap({
          employment: [emp({ company_id: 99, linkedin_company_id: "111", company_name: "Domo Inc" })],
        }),
      }),
    );
    expect(events.filter((e) => e.type === "company_change")).toHaveLength(0);
  });

  it("downgrades to silence when prior current roles have no LinkedIn ids at all", () => {
    const events = computeDiff(
      input({
        companyLinkedinIds: new Map([[10, null], [20, "222"]]),
        nextSnapshot: snap({
          employment: [emp({ company_id: 20, linkedin_company_id: "222", company_name: "Qualtrics" })],
        }),
      }),
    );
    expect(events.filter((e) => e.type === "company_change")).toHaveLength(0);
  });

  it("first-enrichment rule: no employment events when the contact had no rows", () => {
    const events = computeDiff(
      input({
        existingEmployment: [],
        nextSnapshot: snap({ employment: [emp({ company_id: 20, linkedin_company_id: "222" })] }),
      }),
    );
    expect(events.filter((e) => e.type === "company_change" || e.type === "promotion")).toHaveLength(0);
  });

  it("recognizes a boomerang return ('back at')", () => {
    const events = computeDiff(
      input({
        existingEmployment: [
          { company_id: 10, title: "PM", start_month: "Jan 2023", is_current: true },
          { company_id: 20, title: "APM", start_month: "Jan 2019", is_current: false },
        ],
        nextSnapshot: snap({
          employment: [emp({ company_id: 20, linkedin_company_id: "222", company_name: "Qualtrics", title: "Director" })],
        }),
      }),
    );
    const ce = events.find((e) => e.type === "company_change");
    expect(ce!.headline).toBe("Sarah Chen is back at Qualtrics");
  });

  it("fires when the contact had past rows but no current role (new job after a gap)", () => {
    const events = computeDiff(
      input({
        existingEmployment: [{ company_id: 10, title: "PM", start_month: "Jan 2020", is_current: false }],
        nextSnapshot: snap({
          employment: [emp({ company_id: 20, linkedin_company_id: "222", company_name: "Qualtrics" })],
        }),
      }),
    );
    expect(events.filter((e) => e.type === "company_change")).toHaveLength(1);
  });
});

describe("computeDiff — promotion", () => {
  it("fires when title AND start month both change at the same company", () => {
    const events = computeDiff(
      input({
        nextSnapshot: snap({
          employment: [emp({ title: "Director of Product", start_month: "Jun 2026" })],
        }),
      }),
    );
    const p = events.find((e) => e.type === "promotion");
    expect(p).toBeDefined();
    expect(p!.tier).toBe(1);
    expect(p!.dedupeKey).toBe("promotion:7:10:jun 2026");
    expect(p!.evidence).toContain("Was PM");
  });

  it("title-only rewording is noise (no event)", () => {
    const events = computeDiff(
      input({
        existingEmployment: [{ company_id: 10, title: "Sr. PM", start_month: "Jan 2023", is_current: true }],
        nextSnapshot: snap({ employment: [emp({ title: "Senior Product Manager", start_month: "Jan 2023" })] }),
      }),
    );
    expect(events.filter((e) => e.type === "promotion")).toHaveLength(0);
  });

  it("date-only correction is noise (no event)", () => {
    const events = computeDiff(
      input({
        nextSnapshot: snap({ employment: [emp({ title: "PM", start_month: "Feb 2023" })] }),
      }),
    );
    expect(events.filter((e) => e.type === "promotion")).toHaveLength(0);
  });
});

describe("computeDiff — snapshot booleans (baseline rule)", () => {
  it("open_to_work false→true fires Tier-1", () => {
    const events = computeDiff(
      input({
        prevSnapshot: snap({ open_to_work: false }),
        nextSnapshot: snap({ open_to_work: true, employment: [emp()] }),
      }),
    );
    const e = events.find((x) => x.type === "open_to_work");
    expect(e).toBeDefined();
    expect(e!.dedupeKey).toBe("open_to_work:7:2026-07-09");
  });

  it("null→true is baseline, not news (explicit boolean rule)", () => {
    const events = computeDiff(
      input({
        prevSnapshot: snap({ open_to_work: null }),
        nextSnapshot: snap({ open_to_work: true, employment: [emp()] }),
      }),
    );
    expect(events.filter((x) => x.type === "open_to_work")).toHaveLength(0);
  });

  it("no prior snapshot ⇒ no boolean/location/cert events at all", () => {
    const events = computeDiff(
      input({
        prevSnapshot: null,
        nextSnapshot: snap({ open_to_work: true, hiring: true, location_text: "Provo, Utah", certifications: ["PMP"], employment: [emp()] }),
      }),
    );
    expect(events).toHaveLength(0);
  });

  it("hiring false→true fires; true→true stays silent", () => {
    const fires = computeDiff(
      input({ prevSnapshot: snap({ hiring: false }), nextSnapshot: snap({ hiring: true, employment: [emp()] }) }),
    );
    expect(fires.filter((x) => x.type === "hiring")).toHaveLength(1);

    const silent = computeDiff(
      input({ prevSnapshot: snap({ hiring: true }), nextSnapshot: snap({ hiring: true, employment: [emp()] }) }),
    );
    expect(silent.filter((x) => x.type === "hiring")).toHaveLength(0);
  });
});

describe("computeDiff — location & certifications", () => {
  it("location change fires Tier-2 with a new-value dedupe key", () => {
    const events = computeDiff(
      input({
        prevSnapshot: snap({ location_text: "Provo, Utah" }),
        nextSnapshot: snap({ location_text: "Seattle, Washington", employment: [emp()] }),
      }),
    );
    const e = events.find((x) => x.type === "location_change");
    expect(e).toBeDefined();
    expect(e!.tier).toBe(2);
    expect(e!.dedupeKey).toBe("location_change:7:seattle, washington");
  });

  it("no location event when either side is empty (first observation ≠ change)", () => {
    const events = computeDiff(
      input({
        prevSnapshot: snap({ location_text: null }),
        nextSnapshot: snap({ location_text: "Seattle, Washington", employment: [emp()] }),
      }),
    );
    expect(events.filter((x) => x.type === "location_change")).toHaveLength(0);
  });

  it("new certification fires; existing ones don't repeat", () => {
    const events = computeDiff(
      input({
        prevSnapshot: snap({ certifications: ["PMP"] }),
        nextSnapshot: snap({ certifications: ["PMP", "CSPO"], employment: [emp()] }),
      }),
    );
    const certs = events.filter((x) => x.type === "certification");
    expect(certs).toHaveLength(1);
    expect(certs[0].dedupeKey).toBe("certification:7:cspo");
  });
});

describe("buildSnapshot", () => {
  it("normalizes the raw actor item", () => {
    const s = buildSnapshot(
      {
        headline: "  Director of Product at Domo ",
        photo: "https://media.licdn.com/x.jpg",
        location: { linkedinText: "Salt Lake City, Utah" },
        openToWork: true,
        hiring: false,
        certifications: [{ name: "PMP" }, "CSPO", { title: "CSM" }, { name: "  " }],
      } as never,
      [emp()],
    );
    expect(s.headline).toBe("Director of Product at Domo");
    expect(s.has_photo).toBe(true);
    expect(s.location_text).toBe("Salt Lake City, Utah");
    expect(s.open_to_work).toBe(true);
    expect(s.hiring).toBe(false);
    expect(s.certifications).toEqual(["PMP", "CSPO", "CSM"]);
    expect(s.employment).toHaveLength(1);
  });

  it("missing booleans stay null (unknown), not false", () => {
    const s = buildSnapshot({} as never, []);
    expect(s.open_to_work).toBeNull();
    expect(s.hiring).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  EMPTY_COMPANY_FILTERS,
  countByStatus,
  filterCompanies,
  hasActiveCompanyFilters,
  parseCompanyFilters,
  serializeCompanyFilters,
  statusChipCounts,
  type CompanyFilters,
} from "@/lib/company-filters";
import type { CompanySummary, TargetInfo } from "@/lib/company-queries";

/** An office row, the unit the location facet matches on. */
function office(location_id: number, city: string, state: string | null) {
  return {
    location_id,
    city,
    state,
    country: "United States",
    label: state ? `${city}, ${state}` : city,
  };
}

let nextId = 1;
type CompanyOverrides = Omit<Partial<CompanySummary>, "target"> & { target?: Partial<TargetInfo> | null };
function company(overrides: CompanyOverrides): CompanySummary {
  const { target, ...rest } = overrides;
  return {
    id: nextId++,
    name: "Acme",
    logo_url: null,
    linkedin_url: null,
    current_count: 0,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    office_scopes: [],
    offices: [],
    roster: [],
    traction: null,
    ...rest,
    target:
      target == null
        ? null
        : {
            id: 1,
            priority_score: null,
            program_name: null,
            app_window_text: null,
            next_app_date: null,
            status: "researching",
            ...target,
          },
  };
}

function filters(overrides: Partial<CompanyFilters>): CompanyFilters {
  return { ...EMPTY_COMPANY_FILTERS, ...overrides };
}

describe("filterCompanies", () => {
  it("returns everything when filters are empty", () => {
    const rows = [company({ name: "Stripe" }), company({ name: "Adobe", target: null })];
    expect(filterCompanies(rows, EMPTY_COMPANY_FILTERS)).toEqual(rows);
  });

  describe("search", () => {
    it("matches name case-insensitively", () => {
      const rows = [company({ name: "Stripe" }), company({ name: "Adobe" })];
      expect(filterCompanies(rows, filters({ q: "sTrIp" }))).toEqual([rows[0]]);
    });

    it("matches program name", () => {
      const byProgram = company({ name: "Goldman Sachs", target: { program_name: "APM Program" } });
      const rows = [byProgram, company({ name: "Acme" })];
      expect(filterCompanies(rows, filters({ q: "apm" }))).toEqual([byProgram]);
    });

    it("does not search office labels", () => {
      // The retired tier facet WAS in the haystack, so "big tech" matched text.
      // Locations are structured values with their own facet; leaving them in
      // free text would make a q= search silently behave like a location filter.
      const lehi = company({ name: "Acme", offices: [office(1, "Lehi", "Utah")] });
      expect(filterCompanies([lehi], filters({ q: "lehi" }))).toEqual([]);
    });

    it("trims surrounding whitespace", () => {
      const rows = [company({ name: "Stripe" })];
      expect(filterCompanies(rows, filters({ q: "  stripe  " }))).toEqual(rows);
    });

    it("does not match untargeted fields", () => {
      const rows = [company({ name: "Acme", linkedin_url: "https://linkedin.com/company/stripe" })];
      expect(filterCompanies(rows, filters({ q: "stripe" }))).toEqual([]);
    });
  });

  describe("status facet", () => {
    it("keeps only companies in one of the selected statuses", () => {
      const applied = company({ target: { status: "applied" } });
      const interviewing = company({ target: { status: "interviewing" } });
      const researching = company({ target: { status: "researching" } });
      const untargeted = company({ target: null });
      const rows = [applied, interviewing, researching, untargeted];
      expect(filterCompanies(rows, filters({ statuses: ["applied", "interviewing"] }))).toEqual([
        applied,
        interviewing,
      ]);
    });

    it("excludes target-less companies when a status is selected", () => {
      const rows = [company({ target: null })];
      expect(filterCompanies(rows, filters({ statuses: ["researching"] }))).toEqual([]);
    });
  });

  describe("traction facet", () => {
    it("matches the exact stage, excluding null-traction rows", () => {
      const replied = company({ traction: "replied" });
      const rows = [replied, company({ traction: "contacted" }), company({ traction: null })];
      expect(filterCompanies(rows, filters({ traction: ["replied"] }))).toEqual([replied]);
    });

    it("ORs several stages together", () => {
      const replied = company({ traction: "replied" });
      const callDone = company({ traction: "call_done" });
      const contacted = company({ traction: "contacted" });
      const rows = [replied, callDone, contacted, company({ traction: null })];
      expect(filterCompanies(rows, filters({ traction: ["replied", "call_done"] }))).toEqual([
        replied,
        callDone,
      ]);
    });
  });

  describe("location facet", () => {
    const lehi = () => company({ name: "Lehi Co", offices: [office(1, "Lehi", "Utah")] });
    const boston = () => company({ name: "Boston Co", offices: [office(2, "Boston", "Massachusetts")] });

    it("matches one city, excluding companies without an office there", () => {
      const hit = lehi();
      const rows = [hit, boston(), company({ name: "Nowhere Co" })];
      expect(filterCompanies(rows, filters({ locations: ["c:1"] }))).toEqual([hit]);
    });

    it("ORs several cities together", () => {
      const a = lehi();
      const b = boston();
      const rows = [a, b, company({ name: "Austin Co", offices: [office(3, "Austin", "Texas")] })];
      expect(filterCompanies(rows, filters({ locations: ["c:1", "c:2"] }))).toEqual([a, b]);
    });

    it("a state value matches every city in that state", () => {
      const a = lehi();
      const b = company({ name: "Provo Co", offices: [office(4, "Provo", "Utah")] });
      const rows = [a, b, boston()];
      expect(filterCompanies(rows, filters({ locations: ["s:Utah"] }))).toEqual([a, b]);
    });

    it("a state value matches an office added after the selection was made", () => {
      // Why state values are stored as the state and resolved per evaluation
      // rather than expanded into city ids at click time.
      const newCity = company({ name: "Draper Co", offices: [office(99, "Draper", "Utah")] });
      expect(filterCompanies([newCity], filters({ locations: ["s:Utah"] }))).toEqual([newCity]);
    });

    it("matches a company with ANY matching office, not only a single-office one", () => {
      const multi = company({
        name: "Multi Co",
        offices: [office(2, "Boston", "Massachusetts"), office(1, "Lehi", "Utah")],
      });
      expect(filterCompanies([multi], filters({ locations: ["c:1"] }))).toEqual([multi]);
    });

    it("`none` selects exactly the companies with no office at all", () => {
      const bare = company({ name: "Nowhere Co" });
      const rows = [lehi(), bare];
      expect(filterCompanies(rows, filters({ locations: ["none"] }))).toEqual([bare]);
    });

    it("ORs `none` with a city rather than cancelling it", () => {
      const a = lehi();
      const bare = company({ name: "Nowhere Co" });
      const rows = [a, boston(), bare];
      expect(filterCompanies(rows, filters({ locations: ["c:1", "none"] }))).toEqual([a, bare]);
    });

    it("groups an office with no state under its country", () => {
      const belgian = company({
        name: "Belgian Co",
        offices: [{ location_id: 7, city: "Rumst", state: null, country: "Belgium", label: "Rumst, Belgium" }],
      });
      expect(filterCompanies([belgian], filters({ locations: ["s:Belgium"] }))).toEqual([belgian]);
    });

    it("an unparseable value matches nothing rather than everything", () => {
      expect(filterCompanies([lehi()], filters({ locations: ["c:notanumber"] }))).toEqual([]);
    });
  });

  describe("contacts facet", () => {
    const withCurrent = company({ current_count: 2 });
    const withFormer = company({ former_count: 1 });
    const benchOnly = company({ bench_count: 3 });
    const empty = company({});
    const rows = [withCurrent, withFormer, benchOnly, empty];

    it('"with" requires current or former contacts (bench does not count)', () => {
      expect(filterCompanies(rows, filters({ contacts: ["with"] }))).toEqual([withCurrent, withFormer]);
    });

    it('"none" keeps only companies without current/former contacts', () => {
      expect(filterCompanies(rows, filters({ contacts: ["none"] }))).toEqual([benchOnly, empty]);
    });

    it("selecting both sides is the same as selecting neither", () => {
      expect(filterCompanies(rows, filters({ contacts: ["with", "none"] }))).toEqual(rows);
    });
  });

  describe("alumni facet", () => {
    const withAlumni = company({ name: "Stripe", alum_count: 2 });
    const noAlumni = company({ name: "Adobe", alum_count: 0 });
    const rows = [withAlumni, noAlumni];

    it('"with" keeps only companies that have an alum', () => {
      expect(filterCompanies(rows, filters({ alumni: ["with"] }))).toEqual([withAlumni]);
    });

    it('"without" keeps only companies that have none', () => {
      expect(filterCompanies(rows, filters({ alumni: ["without"] }))).toEqual([noAlumni]);
    });

    it("selecting both sides is the same as selecting neither", () => {
      expect(filterCompanies(rows, filters({ alumni: ["with", "without"] }))).toEqual(rows);
    });
  });

  describe("current-employment facet", () => {
    it("keeps only companies where someone works there now", () => {
      const current = company({ name: "Stripe", current_count: 1 });
      // The distinction the facet exists for: "With contacts" keeps this row,
      // because you do know someone — they just left.
      const formerOnly = company({ name: "Adobe", former_count: 4 });
      const benchOnly = company({ name: "Figma", bench_count: 2 });
      const rows = [current, formerOnly, benchOnly];

      expect(filterCompanies(rows, filters({ currentOnly: true }))).toEqual([current]);
      expect(filterCompanies(rows, filters({ contacts: ["with"] }))).toEqual([current, formerOnly]);
    });
  });

  describe("alum-in-product facet", () => {
    it("keeps only companies with a product alum when enabled", () => {
      const withProductAlum = company({ name: "Stripe", product_alum_count: 1 });
      const alumOnly = company({ name: "Figma", alum_count: 2, product_alum_count: 0 });
      const rows = [withProductAlum, alumOnly];
      expect(filterCompanies(rows, filters({ productAlum: true }))).toEqual([withProductAlum]);
    });
  });

  it("ANDs search with facets", () => {
    const match = company({ name: "Stripe", current_count: 1, target: { status: "applied" } });
    const wrongStatus = company({ name: "Stripe Atlas", target: { status: "closed" } });
    const wrongName = company({ name: "Adobe", current_count: 1, target: { status: "applied" } });
    const rows = [match, wrongStatus, wrongName];
    expect(
      filterCompanies(rows, filters({ q: "stripe", statuses: ["applied"], contacts: ["with"] })),
    ).toEqual([match]);
  });

  it("ANDs facets with each other rather than ORing them", () => {
    const both = company({ name: "Stripe", alum_count: 1, offices: [office(1, "Lehi", "Utah")] });
    const locationOnly = company({ name: "Adobe", alum_count: 0, offices: [office(1, "Lehi", "Utah")] });
    const alumniOnly = company({ name: "Lucid", alum_count: 3, offices: [office(2, "Boston", "Massachusetts")] });
    const rows = [both, locationOnly, alumniOnly];
    expect(filterCompanies(rows, filters({ locations: ["c:1"], alumni: ["with"] }))).toEqual([both]);
  });
});

describe("hasActiveCompanyFilters", () => {
  it("is false for empty filters and whitespace-only search", () => {
    expect(hasActiveCompanyFilters(EMPTY_COMPANY_FILTERS)).toBe(false);
    expect(hasActiveCompanyFilters(filters({ q: "   " }))).toBe(false);
  });

  it("is true when any facet or search is active", () => {
    expect(hasActiveCompanyFilters(filters({ q: "x" }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ statuses: ["applied"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ traction: ["replied"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ locations: ["s:Utah"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ contacts: ["none"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ alumni: ["with"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ currentOnly: true }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ productAlum: true }))).toBe(true);
  });
});

describe("countByStatus", () => {
  it("counts rows per status, ignoring untargeted and unknown statuses", () => {
    const rows = [
      company({ target: { status: "applied" } }),
      company({ target: { status: "applied" } }),
      company({ target: { status: "closed" } }),
      company({ target: { status: "bogus" } }),
      company({ target: null }),
    ];
    expect(countByStatus(rows)).toEqual({
      researching: 0,
      outreach_active: 0,
      applied: 2,
      interviewing: 0,
      closed: 1,
    });
  });
});

describe("statusChipCounts", () => {
  // Two states × two statuses, so a location facet has something to cut in both.
  const rows = [
    company({ name: "Stripe", target: { status: "researching" }, offices: [office(1, "Boston", "Massachusetts")] }),
    company({ name: "Adobe", target: { status: "researching" }, offices: [office(1, "Boston", "Massachusetts")] }),
    company({ name: "Lucid", target: { status: "researching" }, offices: [office(2, "Lehi", "Utah")] }),
    company({ name: "Qualtrics", target: { status: "applied" }, offices: [office(2, "Lehi", "Utah")] }),
  ];

  it("matches countByStatus when nothing else is filtering", () => {
    expect(statusChipCounts(rows, EMPTY_COMPANY_FILTERS)).toEqual(countByStatus(rows));
  });

  it("narrows every count by the other facets", () => {
    expect(statusChipCounts(rows, filters({ locations: ["s:Utah"] }))).toEqual({
      researching: 1,
      outreach_active: 0,
      applied: 1,
      interviewing: 0,
      closed: 0,
    });
  });

  it("narrows by the search box too", () => {
    expect(statusChipCounts(rows, filters({ q: "stripe" })).researching).toBe(1);
  });

  it("ignores the status chips themselves, so a selected chip does not zero its siblings", () => {
    // Clicking "Applied" must not report researching: 0 — the whole point of the
    // count is what the OTHER chips would give you.
    expect(statusChipCounts(rows, filters({ statuses: ["applied"] }))).toEqual(countByStatus(rows));
  });

  it("agrees with the visible list for the selected status", () => {
    const f = filters({ statuses: ["researching"], locations: ["s:Massachusetts"] });
    expect(filterCompanies(rows, f)).toHaveLength(statusChipCounts(rows, f).researching);
  });
});

describe("URL param round-trip", () => {
  it("parses a fully-populated query string", () => {
    const params = new URLSearchParams(
      "q=stripe&status=applied,interviewing&traction=replied,call_done&loc=c:412&loc=s:Utah" +
        "&contacts=none&alumni=with&current=1&product_alum=1",
    );
    expect(parseCompanyFilters(params)).toEqual({
      q: "stripe",
      statuses: ["applied", "interviewing"],
      traction: ["replied", "call_done"],
      locations: ["c:412", "s:Utah"],
      contacts: ["none"],
      alumni: ["with"],
      currentOnly: true,
      productAlum: true,
    });
  });

  it("returns empty filters for an empty query string", () => {
    expect(parseCompanyFilters(new URLSearchParams())).toEqual(EMPTY_COMPANY_FILTERS);
  });

  it("drops unknown status/traction/contacts/alumni values instead of throwing", () => {
    const params = new URLSearchParams(
      "status=applied,bogus, ,interviewing&traction=warp&contacts=maybe&alumni=sometimes",
    );
    expect(parseCompanyFilters(params)).toEqual(filters({ statuses: ["applied", "interviewing"] }));
  });

  it("dedupes repeated values", () => {
    expect(parseCompanyFilters(new URLSearchParams("status=applied,applied")).statuses).toEqual([
      "applied",
    ]);
    expect(parseCompanyFilters(new URLSearchParams("loc=s:Utah&loc=s:Utah")).locations).toEqual(["s:Utah"]);
  });

  it("serializes active filters and omits inactive ones", () => {
    const out = serializeCompanyFilters(
      filters({ q: "stripe", statuses: ["applied"], contacts: ["none"] }),
      new URLSearchParams(),
    );
    expect(out.get("q")).toBe("stripe");
    expect(out.get("status")).toBe("applied");
    expect(out.get("contacts")).toBe("none");
    expect(out.has("traction")).toBe(false);
    expect(out.has("loc")).toBe(false);
    expect(out.has("alumni")).toBe(false);
    expect(out.has("current")).toBe(false);
    expect(out.has("product_alum")).toBe(false);
  });

  it("preserves unrelated params and clears stale filter params", () => {
    const base = new URLSearchParams("view=targets&sort=priority&q=old&loc=s:Utah&current=1");
    const out = serializeCompanyFilters(filters({ q: "new" }), base);
    expect(out.get("view")).toBe("targets");
    expect(out.get("sort")).toBe("priority");
    expect(out.get("q")).toBe("new");
    expect(out.has("loc")).toBe(false);
    expect(out.has("current")).toBe(false);
    // base is not mutated
    expect(base.get("q")).toBe("old");
  });

  it("emits one loc param per value rather than joining them", () => {
    // Pinned separately from the round-trip below: comma-joining survives a
    // round-trip for a SINGLE value, so only a multi-value assertion catches it.
    const out = serializeCompanyFilters(filters({ locations: ["c:1", "s:Utah"] }), new URLSearchParams());
    expect(out.getAll("loc")).toEqual(["c:1", "s:Utah"]);
  });

  it("replaces every copy of a repeated loc param rather than appending to it", () => {
    const base = new URLSearchParams("loc=s:Utah&loc=s:Texas");
    const out = serializeCompanyFilters(filters({ locations: ["c:1"] }), base);
    expect(out.getAll("loc")).toEqual(["c:1"]);
  });

  it("round-trips: parse(serialize(f)) === f", () => {
    const f = filters({
      q: "gold",
      statuses: ["outreach_active", "closed"],
      traction: ["call_done", "replied"],
      locations: ["c:412", "s:Utah"],
      contacts: ["with"],
      alumni: ["without"],
      currentOnly: true,
      productAlum: true,
    });
    expect(parseCompanyFilters(serializeCompanyFilters(f, new URLSearchParams()))).toEqual(f);
  });

  it("round-trips a state group containing a comma", () => {
    // Why `loc` is repeated rather than comma-joined, inherited from `tier`:
    // splitting on commas would turn one group into two values matching nothing.
    const f = filters({ locations: ["s:Washington, D.C."] });
    expect(parseCompanyFilters(serializeCompanyFilters(f, new URLSearchParams())).locations).toEqual([
      "s:Washington, D.C.",
    ]);
  });

  describe("links shared before the facets went multi-value", () => {
    it("reads a single-value traction/loc/contacts URL", () => {
      const params = new URLSearchParams("traction=replied&loc=s:Utah&contacts=with");
      expect(parseCompanyFilters(params)).toEqual(
        filters({ traction: ["replied"], locations: ["s:Utah"], contacts: ["with"] }),
      );
    });

    it('reads the retired contacts=any as no contacts filter', () => {
      expect(parseCompanyFilters(new URLSearchParams("contacts=any")).contacts).toEqual([]);
    });

    it("reads a comma-joined group name as ONE value, not two", () => {
      expect(parseCompanyFilters(new URLSearchParams("loc=s:Foo,+Bar")).locations).toEqual(["s:Foo, Bar"]);
    });

    it("drops a stale tier param instead of carrying it into locations", () => {
      // Links shared before CAR-251 carry ?tier=. There is nothing to map it to
      // (Big Tech was never a place), so it must read as no location filter
      // rather than as a value that matches nothing and empties the list.
      expect(parseCompanyFilters(new URLSearchParams("tier=Big+Tech")).locations).toEqual([]);
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  EMPTY_COMPANY_FILTERS,
  countByStatus,
  distinctTiers,
  filterCompanies,
  hasActiveCompanyFilters,
  parseCompanyFilters,
  serializeCompanyFilters,
  statusChipCounts,
  type CompanyFilters,
} from "@/lib/company-filters";
import type { CompanySummary, TargetInfo } from "@/lib/company-queries";

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
    traction: null,
    traction_detail: null,
    ...rest,
    target:
      target == null
        ? null
        : {
            id: 1,
            priority_score: null,
            tier: null,
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

    it("matches program name and tier label", () => {
      const byProgram = company({ name: "Goldman Sachs", target: { program_name: "APM Program" } });
      const byTier = company({ name: "Adobe", target: { tier: "Big Tech" } });
      const rows = [byProgram, byTier, company({ name: "Acme" })];
      expect(filterCompanies(rows, filters({ q: "apm" }))).toEqual([byProgram]);
      expect(filterCompanies(rows, filters({ q: "big tech" }))).toEqual([byTier]);
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

  describe("tier facet", () => {
    it("matches the exact tier label, excluding untargeted/untiered rows", () => {
      const bigTech = company({ target: { tier: "Big Tech" } });
      const rows = [bigTech, company({ target: { tier: "Utah" } }), company({ target: null })];
      expect(filterCompanies(rows, filters({ tiers: ["Big Tech"] }))).toEqual([bigTech]);
    });

    it("ORs several tiers together", () => {
      const bigTech = company({ target: { tier: "Big Tech" } });
      const utah = company({ target: { tier: "Utah" } });
      const finance = company({ target: { tier: "Finance" } });
      const rows = [bigTech, utah, finance];
      expect(filterCompanies(rows, filters({ tiers: ["Big Tech", "Utah"] }))).toEqual([bigTech, utah]);
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
    const both = company({ name: "Stripe", alum_count: 1, target: { tier: "Big Tech" } });
    const tierOnly = company({ name: "Adobe", alum_count: 0, target: { tier: "Big Tech" } });
    const alumniOnly = company({ name: "Lucid", alum_count: 3, target: { tier: "Utah" } });
    const rows = [both, tierOnly, alumniOnly];
    expect(filterCompanies(rows, filters({ tiers: ["Big Tech"], alumni: ["with"] }))).toEqual([both]);
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
    expect(hasActiveCompanyFilters(filters({ tiers: ["Big Tech"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ contacts: ["none"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ alumni: ["with"] }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ currentOnly: true }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ productAlum: true }))).toBe(true);
  });
});

describe("distinctTiers", () => {
  it("returns sorted unique non-empty tiers", () => {
    const rows = [
      company({ target: { tier: "Utah" } }),
      company({ target: { tier: "Big Tech" } }),
      company({ target: { tier: "Utah" } }),
      company({ target: { tier: "  " } }),
      company({ target: { tier: null } }),
      company({ target: null }),
    ];
    expect(distinctTiers(rows)).toEqual(["Big Tech", "Utah"]);
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
  // Two tiers × two statuses, so a tier facet has something to cut in both.
  const rows = [
    company({ name: "Stripe", target: { status: "researching", tier: "Big Tech" } }),
    company({ name: "Adobe", target: { status: "researching", tier: "Big Tech" } }),
    company({ name: "Lucid", target: { status: "researching", tier: "Utah" } }),
    company({ name: "Qualtrics", target: { status: "applied", tier: "Utah" } }),
  ];

  it("matches countByStatus when nothing else is filtering", () => {
    expect(statusChipCounts(rows, EMPTY_COMPANY_FILTERS)).toEqual(countByStatus(rows));
  });

  it("narrows every count by the other facets", () => {
    expect(statusChipCounts(rows, filters({ tiers: ["Utah"] }))).toEqual({
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
    const f = filters({ statuses: ["researching"], tiers: ["Big Tech"] });
    expect(filterCompanies(rows, f)).toHaveLength(statusChipCounts(rows, f).researching);
  });
});

describe("URL param round-trip", () => {
  it("parses a fully-populated query string", () => {
    const params = new URLSearchParams(
      "q=stripe&status=applied,interviewing&traction=replied,call_done&tier=Big+Tech&tier=Utah" +
        "&contacts=none&alumni=with&current=1&product_alum=1",
    );
    expect(parseCompanyFilters(params)).toEqual({
      q: "stripe",
      statuses: ["applied", "interviewing"],
      traction: ["replied", "call_done"],
      tiers: ["Big Tech", "Utah"],
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
    expect(parseCompanyFilters(new URLSearchParams("tier=Utah&tier=Utah")).tiers).toEqual(["Utah"]);
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
    expect(out.has("tier")).toBe(false);
    expect(out.has("alumni")).toBe(false);
    expect(out.has("current")).toBe(false);
    expect(out.has("product_alum")).toBe(false);
  });

  it("preserves unrelated params and clears stale filter params", () => {
    const base = new URLSearchParams("view=targets&sort=priority&q=old&tier=Utah&current=1");
    const out = serializeCompanyFilters(filters({ q: "new" }), base);
    expect(out.get("view")).toBe("targets");
    expect(out.get("sort")).toBe("priority");
    expect(out.get("q")).toBe("new");
    expect(out.has("tier")).toBe(false);
    expect(out.has("current")).toBe(false);
    // base is not mutated
    expect(base.get("q")).toBe("old");
  });

  it("emits one tier param per tier rather than joining them", () => {
    // Pinned separately from the round-trip below: comma-joining survives a
    // round-trip for a SINGLE tier, so only a multi-tier assertion catches it.
    const out = serializeCompanyFilters(filters({ tiers: ["Big Tech", "Utah"] }), new URLSearchParams());
    expect(out.getAll("tier")).toEqual(["Big Tech", "Utah"]);
  });

  it("replaces every copy of a repeated tier param rather than appending to it", () => {
    const base = new URLSearchParams("tier=Utah&tier=Finance");
    const out = serializeCompanyFilters(filters({ tiers: ["Big Tech"] }), base);
    expect(out.getAll("tier")).toEqual(["Big Tech"]);
  });

  it("round-trips: parse(serialize(f)) === f", () => {
    const f = filters({
      q: "gold",
      statuses: ["outreach_active", "closed"],
      traction: ["call_done", "replied"],
      tiers: ["Utah/Silicon Slopes", "Big Tech"],
      contacts: ["with"],
      alumni: ["without"],
      currentOnly: true,
      productAlum: true,
    });
    expect(parseCompanyFilters(serializeCompanyFilters(f, new URLSearchParams()))).toEqual(f);
  });

  it("round-trips a tier label containing a comma", () => {
    // Why `tier` is repeated rather than comma-joined: this label was already
    // shareable as a single-value param, and splitting on commas would turn it
    // into two tiers that match nothing.
    const f = filters({ tiers: ["Provo, UT"] });
    expect(parseCompanyFilters(serializeCompanyFilters(f, new URLSearchParams())).tiers).toEqual([
      "Provo, UT",
    ]);
  });

  describe("links shared before the facets went multi-value", () => {
    it("reads a single-value traction/tier/contacts URL", () => {
      const params = new URLSearchParams("traction=replied&tier=Big+Tech&contacts=with");
      expect(parseCompanyFilters(params)).toEqual(
        filters({ traction: ["replied"], tiers: ["Big Tech"], contacts: ["with"] }),
      );
    });

    it('reads the retired contacts=any as no contacts filter', () => {
      expect(parseCompanyFilters(new URLSearchParams("contacts=any")).contacts).toEqual([]);
    });

    it("reads a comma-joined tier label as ONE tier, not two", () => {
      expect(parseCompanyFilters(new URLSearchParams("tier=Foo,+Bar")).tiers).toEqual(["Foo, Bar"]);
    });
  });
});

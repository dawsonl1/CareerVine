import { describe, it, expect } from "vitest";
import {
  EMPTY_COMPANY_FILTERS,
  countByStatus,
  distinctTiers,
  filterCompanies,
  hasActiveCompanyFilters,
  parseCompanyFilters,
  serializeCompanyFilters,
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
    office_scopes: [],
    traction: null,
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
      expect(filterCompanies(rows, filters({ traction: "replied" }))).toEqual([replied]);
    });
  });

  describe("tier facet", () => {
    it("matches the exact tier label, excluding untargeted/untiered rows", () => {
      const bigTech = company({ target: { tier: "Big Tech" } });
      const rows = [bigTech, company({ target: { tier: "Utah" } }), company({ target: null })];
      expect(filterCompanies(rows, filters({ tier: "Big Tech" }))).toEqual([bigTech]);
    });
  });

  describe("contacts facet", () => {
    const withCurrent = company({ current_count: 2 });
    const withFormer = company({ former_count: 1 });
    const benchOnly = company({ bench_count: 3 });
    const empty = company({});
    const rows = [withCurrent, withFormer, benchOnly, empty];

    it('"with" requires current or former contacts (bench does not count)', () => {
      expect(filterCompanies(rows, filters({ contacts: "with" }))).toEqual([withCurrent, withFormer]);
    });

    it('"none" keeps only companies without current/former contacts', () => {
      expect(filterCompanies(rows, filters({ contacts: "none" }))).toEqual([benchOnly, empty]);
    });
  });

  it("ANDs search with facets", () => {
    const match = company({ name: "Stripe", current_count: 1, target: { status: "applied" } });
    const wrongStatus = company({ name: "Stripe Atlas", target: { status: "closed" } });
    const wrongName = company({ name: "Adobe", current_count: 1, target: { status: "applied" } });
    const rows = [match, wrongStatus, wrongName];
    expect(
      filterCompanies(rows, filters({ q: "stripe", statuses: ["applied"], contacts: "with" })),
    ).toEqual([match]);
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
    expect(hasActiveCompanyFilters(filters({ traction: "replied" }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ tier: "Big Tech" }))).toBe(true);
    expect(hasActiveCompanyFilters(filters({ contacts: "none" }))).toBe(true);
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

describe("URL param round-trip", () => {
  it("parses a fully-populated query string", () => {
    const params = new URLSearchParams(
      "q=stripe&status=applied,interviewing&traction=replied&tier=Big+Tech&contacts=none",
    );
    expect(parseCompanyFilters(params)).toEqual({
      q: "stripe",
      statuses: ["applied", "interviewing"],
      traction: "replied",
      tier: "Big Tech",
      contacts: "none",
    });
  });

  it("returns empty filters for an empty query string", () => {
    expect(parseCompanyFilters(new URLSearchParams())).toEqual(EMPTY_COMPANY_FILTERS);
  });

  it("drops unknown status/traction/contacts values instead of throwing", () => {
    const params = new URLSearchParams("status=applied,bogus, ,interviewing&traction=warp&contacts=maybe");
    expect(parseCompanyFilters(params)).toEqual(
      filters({ statuses: ["applied", "interviewing"] }),
    );
  });

  it("dedupes repeated statuses", () => {
    const params = new URLSearchParams("status=applied,applied");
    expect(parseCompanyFilters(params).statuses).toEqual(["applied"]);
  });

  it("serializes active filters and omits inactive ones", () => {
    const out = serializeCompanyFilters(
      filters({ q: "stripe", statuses: ["applied"], contacts: "none" }),
      new URLSearchParams(),
    );
    expect(out.get("q")).toBe("stripe");
    expect(out.get("status")).toBe("applied");
    expect(out.get("contacts")).toBe("none");
    expect(out.has("traction")).toBe(false);
    expect(out.has("tier")).toBe(false);
  });

  it("preserves unrelated params and clears stale filter params", () => {
    const base = new URLSearchParams("view=targets&sort=priority&q=old&tier=Utah");
    const out = serializeCompanyFilters(filters({ q: "new" }), base);
    expect(out.get("view")).toBe("targets");
    expect(out.get("sort")).toBe("priority");
    expect(out.get("q")).toBe("new");
    expect(out.has("tier")).toBe(false);
    // base is not mutated
    expect(base.get("q")).toBe("old");
  });

  it("round-trips: parse(serialize(f)) === f", () => {
    const f = filters({
      q: "gold",
      statuses: ["outreach_active", "closed"],
      traction: "call_done",
      tier: "Utah/Silicon Slopes",
      contacts: "with",
    });
    expect(parseCompanyFilters(serializeCompanyFilters(f, new URLSearchParams()))).toEqual(f);
  });
});

import { describe, expect, it } from "vitest";
import { deriveCompanyTarget, type CompanyTargetScopeRow } from "@/lib/company-queries";
import { registryOfficeBlocks } from "@/lib/company-scopes";
import type { CompanyOffice } from "@/lib/company-queries";

function scopeRow(overrides: Partial<CompanyTargetScopeRow>): CompanyTargetScopeRow {
  return {
    id: 1,
    location_id: null,
    is_targeted: true,
    priority_score: null,
    tier: null,
    program_name: null,
    app_window_text: null,
    next_app_date: null,
    status: "researching",
    location_label: null,
    ...overrides,
  };
}

describe("deriveCompanyTarget", () => {
  it("returns null when no scope is targeted (containers don't count)", () => {
    const { target, office_scopes } = deriveCompanyTarget([
      scopeRow({ is_targeted: false, tier: "Big Tech" }),
      scopeRow({ id: 2, location_id: 5, is_targeted: false, location_label: "Dallas, Texas" }),
    ]);
    expect(target).toBeNull();
    expect(office_scopes).toEqual([]);
  });

  it("company-wide only: passes the row through, no office scopes", () => {
    const { target, office_scopes } = deriveCompanyTarget([
      scopeRow({ status: "applied", tier: "Big Tech", priority_score: 87 }),
    ]);
    expect(target?.status).toBe("applied");
    expect(target?.tier).toBe("Big Tech");
    expect(target?.priority_score).toBe(87);
    expect(office_scopes).toEqual([]);
  });

  it("office-only: highest-priority office drives status, offices listed", () => {
    const { target, office_scopes } = deriveCompanyTarget([
      scopeRow({ id: 2, location_id: 5, status: "outreach_active", priority_score: 40, location_label: "New York, New York" }),
      scopeRow({ id: 3, location_id: 6, status: "applied", priority_score: 90, location_label: "London, England" }),
    ]);
    expect(target?.status).toBe("applied");
    expect(office_scopes.map((s) => s.label)).toEqual(["London, England", "New York, New York"]);
    expect(office_scopes[0].status).toBe("applied");
  });

  it("mixed: company-wide status wins, offices still listed", () => {
    const { target, office_scopes } = deriveCompanyTarget([
      scopeRow({ status: "researching" }),
      scopeRow({ id: 2, location_id: 5, status: "outreach_active", location_label: "New York, New York" }),
    ]);
    expect(target?.status).toBe("researching");
    expect(office_scopes).toHaveLength(1);
  });

  it("tier/program/window come from the company-wide row even when untargeted", () => {
    const { target } = deriveCompanyTarget([
      scopeRow({ is_targeted: false, tier: "Big Tech", program_name: "APM", app_window_text: "Opens fall" }),
      scopeRow({ id: 2, location_id: 5, status: "applied", location_label: "New York, New York" }),
    ]);
    expect(target?.tier).toBe("Big Tech");
    expect(target?.program_name).toBe("APM");
    expect(target?.app_window_text).toBe("Opens fall");
    expect(target?.status).toBe("applied");
  });

  it("nearest app date and max priority across targeted scopes", () => {
    const { target } = deriveCompanyTarget([
      scopeRow({ next_app_date: "2026-10-01", priority_score: 50 }),
      scopeRow({ id: 2, location_id: 5, next_app_date: "2026-09-15", priority_score: 80, location_label: "New York, New York" }),
      // Untargeted container dates/priority don't participate
      scopeRow({ id: 3, location_id: 6, is_targeted: false, next_app_date: "2026-08-01", priority_score: 99, location_label: "Dallas, Texas" }),
    ]);
    expect(target?.next_app_date).toBe("2026-09-15");
    expect(target?.priority_score).toBe(80);
  });
});

describe("registryOfficeBlocks", () => {
  const office = (overrides: Partial<CompanyOffice>): CompanyOffice => ({
    id: 1,
    location_id: 10,
    source: "manual",
    label: "Denver, Colorado",
    city: "Denver",
    state: "Colorado",
    country: "United States",
    ...overrides,
  });

  it("adds zero-contact registry offices that no facet covered", () => {
    const blocks = registryOfficeBlocks([office({})], new Set(), new Map());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].key).toBe("10");
    expect(blocks[0].contactCount).toBe(0);
    expect(blocks[0].tabLabel).toBe("Denver, CO");
    expect(blocks[0].isTargeted).toBe(false);
  });

  it("skips offices already represented by a contact facet", () => {
    const blocks = registryOfficeBlocks([office({})], new Set(["10"]), new Map());
    expect(blocks).toEqual([]);
  });

  it("carries real targeting state from the scope row", () => {
    const blocks = registryOfficeBlocks(
      [office({})],
      new Set(),
      new Map([
        ["10", { is_targeted: true, status: "outreach_active", next_app_date: "2026-09-01", app_window_text: null }],
      ]),
    );
    expect(blocks[0].isTargeted).toBe(true);
    expect(blocks[0].status).toBe("outreach_active");
    expect(blocks[0].next_app_date).toBe("2026-09-01");
  });
});

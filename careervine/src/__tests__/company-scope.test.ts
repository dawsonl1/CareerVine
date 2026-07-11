import { describe, it, expect } from "vitest";
import { selectCompanyIds } from "@/lib/company-queries";

/**
 * agg helper: build a per-company aggregate with N current and M former
 * (non-bench) contacts. Only the set sizes matter to selectCompanyIds.
 */
function agg(current: number, former: number) {
  return {
    current: new Set(Array.from({ length: current }, (_, i) => i + 1)),
    former: new Set(Array.from({ length: former }, (_, i) => 1000 + i)),
  };
}

describe("selectCompanyIds", () => {
  // 10: explicit target, no contacts. 20: current prospect(s), not targeted.
  // 30: former-only contacts (past employer), not targeted. 40: target AND
  // current contacts (the onboarding-picked company).
  const aggByCompany = new Map([
    [20, agg(2, 0)],
    [30, agg(0, 3)],
    [40, agg(1, 1)],
  ]);
  const targets = [10, 40];

  it("targets scope returns only targeted companies", () => {
    expect(selectCompanyIds("targets", targets, aggByCompany).sort()).toEqual([10, 40]);
  });

  it("in_play adds companies with a current contact, keeps targets, excludes former-only", () => {
    // 10 (target, no contacts) + 40 (target+current) + 20 (current prospect).
    // 30 is former-only → excluded (avoids the past-employer landfill).
    expect(selectCompanyIds("in_play", targets, aggByCompany).sort()).toEqual([10, 20, 40]);
  });

  it("in_play surfaces a prospect company that was never targeted", () => {
    // The reported bug: prospects at company 20, only company 40 targeted.
    expect(selectCompanyIds("in_play", [40], aggByCompany)).toContain(20);
  });

  it("all includes former-only companies above minContacts", () => {
    expect(selectCompanyIds("all", targets, aggByCompany, 1).sort()).toEqual([10, 20, 30, 40]);
  });

  it("all respects minContacts", () => {
    // Only 20 (2 current) and 30 (3 former) meet minContacts=2; 40 has 1+1=2 too.
    // Targets are always included regardless of contact count.
    expect(selectCompanyIds("all", targets, aggByCompany, 3).sort()).toEqual([10, 30, 40]);
  });

  it("never duplicates a company that is both targeted and has contacts", () => {
    const ids = selectCompanyIds("in_play", targets, aggByCompany);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 40)).toHaveLength(1);
  });

  it("empty inputs yield an empty list", () => {
    expect(selectCompanyIds("in_play", [], new Map())).toEqual([]);
  });
});

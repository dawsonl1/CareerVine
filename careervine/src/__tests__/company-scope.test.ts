import { describe, it, expect } from "vitest";
import { selectCompanyIds } from "@/lib/company-queries";

/**
 * agg helper: build a per-company aggregate with N current, M former, and
 * (of the current) P prospect contacts. Only the set sizes matter to
 * selectCompanyIds. `currentProspect` ⊆ `current`.
 */
function agg(current: number, former: number, prospect = 0) {
  return {
    current: new Set(Array.from({ length: current }, (_, i) => i + 1)),
    former: new Set(Array.from({ length: former }, (_, i) => 1000 + i)),
    currentProspect: new Set(Array.from({ length: prospect }, (_, i) => i + 1)),
  };
}

describe("selectCompanyIds", () => {
  // 10: explicit target, no contacts.
  // 20: current *prospect* contacts, not targeted (intentionally in the funnel).
  // 25: current *active* contacts only, not targeted (imported network — noise).
  // 30: former-only contacts (past employer), not targeted.
  // 40: target AND a current active contact (the onboarding-picked company).
  const aggByCompany = new Map([
    [20, agg(2, 0, 2)],
    [25, agg(2, 0, 0)],
    [30, agg(0, 3, 0)],
    [40, agg(1, 1, 0)],
  ]);
  const targets = [10, 40];

  it("targets scope returns only targeted companies", () => {
    expect(selectCompanyIds("targets", targets, aggByCompany).sort()).toEqual([10, 40]);
  });

  it("pursuing = targets ∪ companies with a current prospect; drops active-only noise", () => {
    // 10 + 40 (targets) + 20 (current prospect). 25 (active-only) and 30
    // (former-only) are excluded — the clutter the redesign removes.
    expect(selectCompanyIds("pursuing", targets, aggByCompany).sort()).toEqual([10, 20, 40]);
  });

  it("pursuing surfaces a prospect company that was never targeted", () => {
    // CAR-89's win preserved: prospects at 20 show even with only 40 targeted.
    expect(selectCompanyIds("pursuing", [40], aggByCompany)).toContain(20);
  });

  it("pursuing excludes a company whose only tie is an active contact", () => {
    expect(selectCompanyIds("pursuing", [40], aggByCompany)).not.toContain(25);
  });

  it("in_play adds any company with a current contact (active or prospect)", () => {
    // Broader than pursuing: 25 (active-only) is included here. 30 former-only excluded.
    expect(selectCompanyIds("in_play", targets, aggByCompany).sort()).toEqual([10, 20, 25, 40]);
  });

  it("all includes former-only companies above minContacts", () => {
    expect(selectCompanyIds("all", targets, aggByCompany, 1).sort()).toEqual([10, 20, 25, 30, 40]);
  });

  it("all respects minContacts", () => {
    // minContacts=3: 30 (3 former) qualifies; 20/25 (2 current) and 40 (1+1) do not.
    // Targets (10, 40) are always included regardless of contact count.
    expect(selectCompanyIds("all", targets, aggByCompany, 3).sort()).toEqual([10, 30, 40]);
  });

  it("never duplicates a company that is both targeted and has contacts", () => {
    const ids = selectCompanyIds("pursuing", targets, aggByCompany);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 40)).toHaveLength(1);
  });

  it("empty inputs yield an empty list", () => {
    expect(selectCompanyIds("pursuing", [], new Map())).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { deriveNextAction, daysUntil, nextActionForCompany, type NextActionInput } from "@/lib/company-next-action";
import type { CompanySummary } from "@/lib/company-queries";

const NOW = new Date("2026-07-11T12:00:00");

function input(partial: Partial<NextActionInput>): NextActionInput {
  return {
    status: null,
    nextAppDate: null,
    traction: null,
    currentCount: 0,
    alumCount: 0,
    productAlumCount: 0,
    recruiterCount: 0,
    leadName: null,
    ...partial,
  };
}

describe("daysUntil", () => {
  it("counts whole days from local midnight", () => {
    expect(daysUntil("2026-07-11", NOW)).toBe(0);
    expect(daysUntil("2026-07-14", NOW)).toBe(3);
    expect(daysUntil("2026-07-10", NOW)).toBe(-1);
  });
});

describe("deriveNextAction — state ladder", () => {
  it("interviewing outranks everything else", () => {
    const a = deriveNextAction(input({ status: "interviewing" }), NOW);
    expect(a.tone).toBe("urgent");
    expect(a.rank).toBe(100);
    expect(a.text).toMatch(/interviewing/i);
  });

  it("closed is inert", () => {
    const a = deriveNextAction(input({ status: "closed" }), NOW);
    expect(a.text).toBe("Closed");
    expect(a.rank).toBeLessThan(10);
  });

  it("an imminent deadline is urgent and phrased in days", () => {
    expect(deriveNextAction(input({ nextAppDate: "2026-07-11" }), NOW).text).toMatch(/today/);
    expect(deriveNextAction(input({ nextAppDate: "2026-07-12" }), NOW).text).toMatch(/tomorrow/);
    const soon = deriveNextAction(input({ nextAppDate: "2026-07-14" }), NOW);
    expect(soon.tone).toBe("urgent");
    expect(soon.text).toMatch(/in 3 days/);
  });

  it("sooner deadlines rank above later ones", () => {
    const today = deriveNextAction(input({ nextAppDate: "2026-07-11" }), NOW).rank;
    const week = deriveNextAction(input({ nextAppDate: "2026-07-18" }), NOW).rank;
    expect(today).toBeGreaterThan(week);
  });
});

describe("deriveNextAction — live threads vs deadlines", () => {
  it("orders referral > call scheduled > replied", () => {
    const referral = deriveNextAction(input({ traction: "referral" }), NOW).rank;
    const call = deriveNextAction(input({ traction: "call_scheduled" }), NOW).rank;
    const replied = deriveNextAction(input({ traction: "replied" }), NOW).rank;
    expect(referral).toBeGreaterThan(call);
    expect(call).toBeGreaterThan(replied);
  });

  it("a live reply beats a mid-range (10-day) deadline", () => {
    const replied = deriveNextAction(input({ traction: "replied", nextAppDate: "2026-07-21" }), NOW);
    // replied wins the branch — the deadline never overrides the action text.
    expect(replied.text).toMatch(/repl/i);
    expect(replied.rank).toBeGreaterThan(deriveNextAction(input({ nextAppDate: "2026-07-21" }), NOW).rank);
  });

  it("an imminent (3-day) deadline beats a live reply", () => {
    const both = deriveNextAction(input({ traction: "replied", nextAppDate: "2026-07-14" }), NOW);
    expect(both.text).toMatch(/apply/i);
    expect(both.tone).toBe("urgent");
  });

  it("names the lead by first name when there's momentum", () => {
    const a = deriveNextAction(input({ traction: "replied", leadName: "Sarah Chen" }), NOW);
    expect(a.text).toContain("Sarah");
    expect(a.text).not.toContain("Chen");
  });
});

describe("deriveNextAction — warm intros", () => {
  it("prefers a BYU alum reach-out and names them", () => {
    const a = deriveNextAction(input({ currentCount: 3, alumCount: 1, leadName: "Mark Lee" }), NOW);
    expect(a.text).toMatch(/Mark/);
    expect(a.text).toMatch(/BYU alum/i);
    expect(a.icon).toBe("GraduationCap");
  });

  it("elevates a BYU alum in product above a plain alum and calls out the role", () => {
    const product = deriveNextAction(input({ currentCount: 2, alumCount: 1, productAlumCount: 1, leadName: "Dana Cho" }), NOW);
    const plain = deriveNextAction(input({ currentCount: 2, alumCount: 1 }), NOW);
    expect(product.text).toMatch(/in product/i);
    expect(product.text).toContain("Dana");
    expect(product.rank).toBeGreaterThan(plain.rank);
  });

  it("falls back to a generic reach-out with a count when no lead name", () => {
    const a = deriveNextAction(input({ currentCount: 4 }), NOW);
    expect(a.text).toMatch(/4 people/);
  });

  it("de-emphasizes warm-untouched: engagement outranks a cold alum reach-out", () => {
    const alum = deriveNextAction(input({ currentCount: 2, alumCount: 1 }), NOW).rank;
    const waiting = deriveNextAction(input({ traction: "contacted", currentCount: 2 }), NOW).rank;
    const replied = deriveNextAction(input({ traction: "replied", currentCount: 2 }), NOW).rank;
    // Momentum leads: anything you've already started ranks above an untouched intro.
    expect(waiting).toBeGreaterThan(alum);
    expect(replied).toBeGreaterThan(alum);
  });

  it("but a warm alum still ranks above knowing no one", () => {
    const alum = deriveNextAction(input({ currentCount: 2, alumCount: 1 }), NOW).rank;
    const findPeople = deriveNextAction(input({ status: "researching", currentCount: 0 }), NOW).rank;
    expect(alum).toBeGreaterThan(findPeople);
  });
});

describe("deriveNextAction — no contacts and past due", () => {
  it("a targeted company with nobody known nudges discovery", () => {
    const a = deriveNextAction(input({ status: "researching", currentCount: 0 }), NOW);
    expect(a.text).toMatch(/find people/i);
  });

  it("a past-due deadline is surfaced, not hidden", () => {
    const a = deriveNextAction(input({ status: "researching", nextAppDate: "2026-07-01" }), NOW);
    expect(a.text).toMatch(/closed/i);
  });
});

describe("nextActionForCompany adapter", () => {
  it("maps a CompanySummary onto the ladder", () => {
    const c = {
      id: 1,
      name: "Stripe",
      logo_url: null,
      linkedin_url: null,
      current_count: 8,
      former_count: 0,
      bench_count: 0,
      alum_count: 2,
      product_alum_count: 1,
      recruiter_count: 1,
      lead_contact_name: "Sarah Chen",
      target: {
        id: 1,
        priority_score: 90,
        tier: "Tier 1",
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "outreach_active",
      },
      office_scopes: [],
      traction: "replied",
    } satisfies CompanySummary;
    const a = nextActionForCompany(c, NOW);
    expect(a.text).toContain("Sarah");
    expect(a.text).toMatch(/replied/i);
  });
});

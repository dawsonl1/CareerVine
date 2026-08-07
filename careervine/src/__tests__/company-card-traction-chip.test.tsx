// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CompanySummary } from "@/lib/company-queries";

/**
 * How the traction chip renders (CAR-246).
 *
 * The chip degrades in two steps rather than showing a number it cannot support,
 * and each step has a real trigger behind it: a `stage_override` gives a stage
 * with no events, and a referral gives events with no date (the `referrals` table
 * has no timestamp column). Both used to be impossible because the chip only ever
 * printed a label.
 */

vi.mock("@/hooks/use-alumni-affinity", () => ({
  useAlumniAffinity: () => ({ abbr: "BYU", name: "BYU" }),
}));

import { CompanyCard } from "@/components/companies/company-card";

function company(over: Partial<CompanySummary> = {}): CompanySummary {
  return {
    id: 1,
    name: "Helpside",
    logo_url: null,
    linkedin_url: null,
    current_count: 1,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: "Kelson Reid",
    target: null,
    office_scopes: [],
    traction: "call_done",
    traction_detail: { count: 2, at: daysAgo(14) },
    ...over,
  };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

afterEach(cleanup);

describe("traction chip rendering (CAR-246)", () => {
  it("pluralizes the count and appends how long ago", () => {
    render(<CompanyCard company={company()} />);
    expect(screen.getByText("2 Calls Done (2 weeks ago)")).toBeTruthy();
  });

  it("uses the singular label for a count of one", () => {
    render(<CompanyCard company={company({ traction: "replied", traction_detail: { count: 1, at: daysAgo(1) } })} />);
    expect(screen.getByText("1 Reply (yesterday)")).toBeTruthy();
  });

  it("keeps the count when there is no usable date", () => {
    // A referral with no linked meeting: real events, no timestamp anywhere.
    render(<CompanyCard company={company({ traction: "referral", traction_detail: { count: 2, at: null } })} />);
    expect(screen.getByText("2 Referrals")).toBeTruthy();
  });

  it("falls back to the bare label when the stage has no events behind it", () => {
    // The stage_override case. "0 Replies" would be a claim about the data that
    // the data does not make.
    render(<CompanyCard company={company({ traction: "replied", traction_detail: { count: 0, at: null } })} />);
    expect(screen.getByText("Replied")).toBeTruthy();
    expect(screen.queryByText(/0 Repl/)).toBeNull();
  });

  it("renders no chip at all when there is no traction", () => {
    render(<CompanyCard company={company({ traction: null, traction_detail: null })} />);
    for (const label of [/Calls Done/, /Repl/, /Contacted/, /Referral/]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});

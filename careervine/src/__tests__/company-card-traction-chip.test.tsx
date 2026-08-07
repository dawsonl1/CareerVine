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
    offices: [],
    roster: [],
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

  it("renders no next-action pill when nobody currently works there", () => {
    // The Qualtrics card: former contacts only. Both badges go quiet, and
    // nothing takes their place (CAR-246).
    render(
      <CompanyCard
        company={company({
          current_count: 0,
          former_count: 20,
          lead_contact_name: null,
          traction: null,
          traction_detail: null,
        })}
      />,
    );

    expect(screen.getByText("20 former contacts")).toBeTruthy();
    expect(screen.queryByText(/Find people who work here/)).toBeNull();
    expect(screen.queryByText(/Follow up with/)).toBeNull();
    expect(screen.queryByText(/Reach out/)).toBeNull();
  });

  it("still shows an imminent deadline with nobody currently there", () => {
    // The over-reach guard, at the render layer: silence is for people-finding
    // advice, never for a fact about the application.
    // Built from LOCAL parts on purpose: `toISOString().slice(0, 10)` reports
    // tomorrow's UTC date for any evening in a negative-offset zone, which
    // silently turns "in 3 days" into "in 4 days" here. daysUntil parses
    // `${date}T00:00:00` as local, so the string has to be local too.
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const soonLocal = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
    render(
      <CompanyCard
        company={company({
          current_count: 0,
          former_count: 20,
          lead_contact_name: null,
          traction: null,
          traction_detail: null,
          target: {
            id: 1,
            priority_score: null,
            program_name: null,
            app_window_text: null,
            next_app_date: soonLocal,
            status: "researching",
          },
        })}
      />,
    );

    expect(screen.getByText(/Apply in 3 days/)).toBeTruthy();
  });
});

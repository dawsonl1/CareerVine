/**
 * Unit tests for the due-follow-ups rule (CAR-155).
 *
 * The clock-injection behavior is covered by health-neglected-and-clock.test.ts;
 * this file pins the policy itself plus the rule-internal active-only gate:
 * prospect/bench rows are excluded even when a caller forgets the SQL-level
 * network_status filter.
 */

import { describe, expect, it } from "vitest";
import { deriveDueFollowUps, type DueFollowUpSourceRow } from "@/lib/rules/due-follow-ups";

const NOW = "2026-04-10T12:00:00.000Z";

const row = (over: Partial<DueFollowUpSourceRow> = {}): DueFollowUpSourceRow => ({
  id: 1,
  name: "Nora",
  industry: null,
  follow_up_frequency_days: 30,
  photo_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  first_outreach_skipped: null,
  reach_out_snoozed_until: null,
  network_status: "active",
  contact_emails: [{ email: "nora@x.com" }],
  ...over,
});

describe("deriveDueFollowUps", () => {
  it("excludes prospect and bench contacts even without a SQL-level filter", () => {
    const out = deriveDueFollowUps(
      [
        row({ id: 1, network_status: "active" }),
        row({ id: 2, name: "Pat Prospect", network_status: "prospect" }),
        row({ id: 3, name: "Ben Bench", network_status: "bench" }),
      ],
      new Map([
        [1, "2026-01-15"],
        [2, "2026-01-15"],
        [3, "2026-01-15"],
      ]),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual([1]);
  });

  it("computes days_overdue from last touch + cadence and drops not-yet-due contacts", () => {
    const out = deriveDueFollowUps(
      [
        row({ id: 1, follow_up_frequency_days: 30 }), // touched 2026-03-01 → due 2026-03-31 → 10 days overdue
        row({ id: 2, name: "Fresh Fay", follow_up_frequency_days: 30 }), // touched 2026-04-01 → not due
      ],
      new Map([
        [1, "2026-03-01"],
        [2, "2026-04-01"],
      ]),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual([1]);
    expect(out[0].days_overdue).toBe(10);
    expect(out[0].never_contacted).toBe(false);
  });

  it("drops snoozed contacts and surfaces contacted no-cadence contacts at days_overdue 0", () => {
    const out = deriveDueFollowUps(
      [
        row({ id: 1, reach_out_snoozed_until: "2026-05-01T00:00:00.000Z" }),
        row({ id: 2, name: "Nocadence Ned", follow_up_frequency_days: null }),
      ],
      new Map([
        [1, "2026-01-01"],
        [2, "2026-01-01"],
      ]),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual([2]);
    expect(out[0].no_cadence).toBe(true);
    expect(out[0].days_overdue).toBe(0);
  });

  it("sorts cadence entries by days_overdue desc and pushes no-cadence entries last", () => {
    const out = deriveDueFollowUps(
      [
        row({ id: 1, follow_up_frequency_days: null }), // no cadence → last
        row({ id: 2, name: "Very Overdue", follow_up_frequency_days: 10 }),
        row({ id: 3, name: "Mildly Overdue", follow_up_frequency_days: 60 }),
      ],
      new Map([
        [1, "2026-01-01"],
        [2, "2026-01-01"],
        [3, "2026-01-01"],
      ]),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual([2, 3, 1]);
  });
});

/**
 * Unit tests for the neglected-contacts rule (CAR-155), including the
 * rule-internal active-only gate: prospect/bench rows are excluded even when
 * a caller forgets the SQL-level network_status filter.
 */

import { describe, expect, it } from "vitest";
import { deriveNeglectedContacts, type NeglectedSourceRow } from "@/lib/rules/neglected";

const row = (over: Partial<NeglectedSourceRow> = {}): NeglectedSourceRow => ({
  id: 1,
  name: "Nora",
  photo_url: null,
  follow_up_frequency_days: 30,
  first_outreach_skipped: null,
  network_status: "active",
  days_since_touch: 0,
  ...over,
});

describe("deriveNeglectedContacts", () => {
  it("excludes prospect and bench contacts even without a SQL-level filter", () => {
    const out = deriveNeglectedContacts([
      row({ id: 1, days_since_touch: 90, network_status: "active" }),
      row({ id: 2, days_since_touch: 90, network_status: "prospect" }),
      row({ id: 3, days_since_touch: 90, network_status: "bench" }),
    ]);
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("flags contacts 2x+ past their cadence and ignores contacts without one", () => {
    const out = deriveNeglectedContacts([
      row({ id: 1, days_since_touch: 60, follow_up_frequency_days: 30 }), // exactly 2x → neglected
      row({ id: 2, days_since_touch: 59, follow_up_frequency_days: 30 }), // under 2x → fine
      row({ id: 3, days_since_touch: 500, follow_up_frequency_days: null }), // no cadence → never neglected
    ]);
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("treats never-contacted as neglected unless first outreach was skipped", () => {
    const out = deriveNeglectedContacts([
      row({ id: 1, days_since_touch: null, first_outreach_skipped: false }),
      row({ id: 2, days_since_touch: null, first_outreach_skipped: true }),
    ]);
    expect(out.map((c) => c.id)).toEqual([1]);
  });

  it("sorts by overdue ratio, never-contacted first", () => {
    const out = deriveNeglectedContacts([
      row({ id: 1, days_since_touch: 90, follow_up_frequency_days: 30 }), // ratio 3
      row({ id: 2, days_since_touch: 300, follow_up_frequency_days: 30 }), // ratio 10
      row({ id: 3, days_since_touch: null }), // ratio sentinel 999 → first
    ]);
    expect(out.map((c) => c.id)).toEqual([3, 2, 1]);
  });
});

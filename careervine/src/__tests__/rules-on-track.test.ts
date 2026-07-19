/**
 * Unit tests for the relationships-on-track rule (CAR-155), including the
 * rule-internal active-only gate: prospect/bench rows are excluded even when
 * a caller forgets the SQL-level network_status filter.
 */

import { describe, expect, it } from "vitest";
import { deriveRelationshipsOnTrack, type OnTrackSourceRow } from "@/lib/rules/on-track";

const NOW = "2026-04-10T12:00:00.000Z";

const row = (over: Partial<OnTrackSourceRow> = {}): OnTrackSourceRow => ({
  id: 1,
  follow_up_frequency_days: 30,
  created_at: "2026-01-01T00:00:00.000Z",
  first_outreach_skipped: null,
  network_status: "active",
  ...over,
});

describe("deriveRelationshipsOnTrack", () => {
  it("excludes prospect and bench contacts even without a SQL-level filter", () => {
    const result = deriveRelationshipsOnTrack(
      [
        row({ id: 1, network_status: "active" }),
        row({ id: 2, network_status: "prospect" }),
        row({ id: 3, network_status: "bench" }),
      ],
      new Map([
        [1, "2026-04-01"],
        [2, "2026-04-01"],
        [3, "2026-04-01"],
      ]),
      NOW,
    );
    expect(result.total).toBe(1);
    expect(result.onTrack).toBe(1);
    expect(result.percentage).toBe(100);
  });

  it("splits on-track vs overdue by cadence against last touch", () => {
    const result = deriveRelationshipsOnTrack(
      [
        row({ id: 1, follow_up_frequency_days: 30 }), // touched 9 days ago → on track
        row({ id: 2, follow_up_frequency_days: 7 }), // touched 40 days ago → overdue
      ],
      new Map([
        [1, "2026-04-01"],
        [2, "2026-03-01"],
      ]),
      NOW,
    );
    expect(result).toEqual({
      percentage: 50,
      onTrack: 1,
      total: 2,
      breakdown: { withCadenceOnTrack: 1, withCadenceOverdue: 1, noCadence: 0, neverContactedPast7d: 0 },
    });
  });

  it("counts contacted no-cadence contacts in the denominator but never on track", () => {
    const result = deriveRelationshipsOnTrack(
      [row({ id: 1, follow_up_frequency_days: null })],
      new Map([[1, "2026-04-09"]]),
      NOW,
    );
    expect(result.total).toBe(1);
    expect(result.onTrack).toBe(0);
    expect(result.breakdown.noCadence).toBe(1);
  });

  it("skips never-contacted contacts inside the Recently Added window and skipped-outreach contacts", () => {
    const result = deriveRelationshipsOnTrack(
      [
        row({ id: 1, created_at: "2026-04-09T00:00:00.000Z" }), // recent, never contacted → excluded
        row({ id: 2, first_outreach_skipped: true }), // explicitly skipped → excluded
        row({ id: 3, created_at: "2026-01-01T00:00:00.000Z", follow_up_frequency_days: 30 }), // past window, never contacted, overdue from created_at
      ],
      new Map(),
      NOW,
    );
    expect(result.total).toBe(1);
    expect(result.breakdown.neverContactedPast7d).toBe(1);
    expect(result.breakdown.withCadenceOverdue).toBe(1);
  });

  it("returns 100% for an empty population", () => {
    expect(deriveRelationshipsOnTrack([], new Map(), NOW)).toEqual({
      percentage: 100,
      onTrack: 0,
      total: 0,
      breakdown: { withCadenceOnTrack: 0, withCadenceOverdue: 0, noCadence: 0, neverContactedPast7d: 0 },
    });
  });
});

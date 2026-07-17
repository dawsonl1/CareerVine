import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-139: backfillEmailsForContact claims orphaned email_messages rows with
 * a conditional update on matched_contact_id — the same column its filter
 * tests. That is the rule-17 CAS shape, so success must be detected via
 * count, never a .select() read-back on the update.
 */

const h = vi.hoisted(() => {
  const state: {
    updates: Array<{ patch: Record<string, unknown>; selected: boolean; filters: Array<[string, string, unknown]> }>;
    counts: number[];
  } = { updates: [], counts: [] };

  function makeBuilder() {
    let entry: { patch: Record<string, unknown>; selected: boolean; filters: Array<[string, string, unknown]> } | null = null;
    let isCount = false;
    const builder: Record<string, unknown> = {
      update: (patch: Record<string, unknown>, opts?: { count?: string }) => {
        entry = { patch, selected: false, filters: [] };
        if (opts?.count) isCount = true;
        state.updates.push(entry);
        return builder;
      },
      select: () => {
        if (entry) entry.selected = true;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        entry?.filters.push(["eq", col, val]);
        return builder;
      },
      is: (col: string, val: unknown) => {
        entry?.filters.push(["is", col, val]);
        return builder;
      },
      contains: (col: string, val: unknown) => {
        entry?.filters.push(["contains", col, val]);
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: isCount ? (state.counts.shift() ?? 0) : null }).then(resolve),
    };
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: () => h.makeBuilder() }),
}));

import { backfillEmailsForContact } from "@/lib/gmail";

describe("backfillEmailsForContact (CAR-139 rule-17 CAS)", () => {
  beforeEach(() => {
    h.state.updates = [];
    h.state.counts = [];
  });

  it("detects claims via count with no .select() read-back, and sums both directions", async () => {
    h.state.counts = [2, 1]; // from_address matches, to_addresses matches

    const total = await backfillEmailsForContact("u-1", 42, ["Amy@Y.com"]);

    expect(total).toBe(3);
    expect(h.state.updates).toHaveLength(2);
    for (const u of h.state.updates) {
      expect(u.patch).toEqual({ matched_contact_id: 42 });
      // The rule-17 trap: never read the claim back through the filtered column.
      expect(u.selected).toBe(false);
      expect(u.filters).toContainEqual(["is", "matched_contact_id", null]);
    }
    // Case-normalized address in both filter directions.
    expect(h.state.updates[0].filters).toContainEqual(["eq", "from_address", "amy@y.com"]);
    expect(h.state.updates[1].filters).toContainEqual(["contains", "to_addresses", ["amy@y.com"]]);
  });

  it("returns 0 without touching the DB when the contact has no emails", async () => {
    const total = await backfillEmailsForContact("u-1", 42, []);
    expect(total).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-139: backfillEmailsForContact claims orphaned email_messages rows with
 * a conditional update on matched_contact_id — the same column its filter
 * tests. That is the rule-17 CAS shape, so success must be detected via
 * count, never a .select() read-back on the update.
 *
 * CAR-172: the backfill runs per page view (GET /api/gmail/emails), so it
 * gates itself on contacts.email_backfilled_at — warm contacts no-op instead
 * of full-scanning — and stamps completion with the same contract as the sync
 * watermark (held on failure, CAS-guarded against a concurrent reset).
 */

const h = vi.hoisted(() => {
  interface Update {
    table: string;
    patch: Record<string, unknown>;
    selected: boolean;
    filters: Array<[string, string, unknown]>;
  }
  const state: {
    updates: Update[];
    counts: number[];
    /** Row served to the gate's contacts read (maybeSingle). */
    contactRow: Record<string, unknown> | null;
    /** Tables whose update resolves with an error (to pin the held stamp). */
    failUpdatesOn: Set<string>;
  } = { updates: [], counts: [], contactRow: null, failUpdatesOn: new Set() };

  function makeBuilder(table: string) {
    let entry: Update | null = null;
    let isCount = false;
    const builder: Record<string, unknown> = {
      update: (patch: Record<string, unknown>, opts?: { count?: string }) => {
        entry = { table, patch, selected: false, filters: [] };
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
      // CAR-159 junction pass plumbing: id-lookup selects paginate via
      // order/range, links land via upsert. Reads resolve empty here — the
      // junction behavior itself is covered on the fake-gmail harness
      // (gmail-junction-links.test.ts); this suite pins the CAS claim shape
      // and the CAR-172 gate/stamp contract.
      order: () => builder,
      range: () => builder,
      upsert: () => builder,
      maybeSingle: async () => ({ data: table === "contacts" ? state.contactRow : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const failed = entry && state.failUpdatesOn.has(entry.table);
        return Promise.resolve({
          data: null,
          error: failed ? { message: `injected ${entry?.table} update failure` } : null,
          count: isCount ? (state.counts.shift() ?? 0) : null,
        }).then(resolve);
      },
    };
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: (t: string) => h.makeBuilder(t) }),
}));

import { backfillEmailsForContact } from "@/lib/gmail";

const claimUpdates = () => h.state.updates.filter((u) => u.table === "email_messages");
const stampUpdates = () => h.state.updates.filter((u) => u.table === "contacts");

/** An ISO instant safely older than the 24h staleness window. */
const STALE_ISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
/** An ISO instant safely inside it. */
const FRESH_ISO = new Date(Date.now() - 60 * 1000).toISOString();

describe("backfillEmailsForContact (CAR-139 rule-17 CAS)", () => {
  beforeEach(() => {
    h.state.updates = [];
    h.state.counts = [];
    h.state.contactRow = null;
    h.state.failUpdatesOn = new Set();
  });

  it("detects claims via count with no .select() read-back, and sums both directions", async () => {
    h.state.counts = [2, 1]; // from_address matches, to_addresses matches

    const total = await backfillEmailsForContact("u-1", 42, ["Amy@Y.com"], { backfilledAt: null });

    expect(total).toBe(3);
    expect(claimUpdates()).toHaveLength(2);
    for (const u of claimUpdates()) {
      expect(u.patch).toEqual({ matched_contact_id: 42 });
      // The rule-17 trap: never read the claim back through the filtered column.
      expect(u.selected).toBe(false);
      expect(u.filters).toContainEqual(["is", "matched_contact_id", null]);
    }
    // Case-normalized address in both filter directions.
    expect(claimUpdates()[0].filters).toContainEqual(["eq", "from_address", "amy@y.com"]);
    expect(claimUpdates()[1].filters).toContainEqual(["contains", "to_addresses", ["amy@y.com"]]);
  });

  it("returns 0 without touching the DB when the contact has no emails", async () => {
    const total = await backfillEmailsForContact("u-1", 42, []);
    expect(total).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });
});

describe("backfillEmailsForContact staleness gate + completion stamp (CAR-172)", () => {
  beforeEach(() => {
    h.state.updates = [];
    h.state.counts = [];
    h.state.contactRow = null;
    h.state.failUpdatesOn = new Set();
  });

  it("no-ops on a warm contact (prefetched stamp inside the window)", async () => {
    const total = await backfillEmailsForContact("u-1", 42, ["amy@y.com"], {
      backfilledAt: FRESH_ISO,
    });
    expect(total).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("runs when the prefetched stamp is stale, and CAS-stamps against the value it read", async () => {
    h.state.counts = [0, 0];
    await backfillEmailsForContact("u-1", 42, ["amy@y.com"], { backfilledAt: STALE_ISO });

    expect(claimUpdates()).toHaveLength(2);
    const stamps = stampUpdates();
    expect(stamps).toHaveLength(1);
    expect(Object.keys(stamps[0].patch)).toEqual(["email_backfilled_at"]);
    // CAS guard: only overwrite the exact stamp the gate read, so a concurrent
    // address-add's trigger reset (→ NULL) is never clobbered by this pass.
    expect(stamps[0].filters).toContainEqual(["eq", "id", 42]);
    expect(stamps[0].filters).toContainEqual(["eq", "email_backfilled_at", STALE_ISO]);
    expect(stamps[0].selected).toBe(false);
  });

  it("fetches the stamp itself when the caller does not prefetch, and gates on it", async () => {
    h.state.contactRow = { email_backfilled_at: FRESH_ISO };
    const total = await backfillEmailsForContact("u-1", 42, ["amy@y.com"]);
    expect(total).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("stamps with an IS NULL guard when the contact had never been backfilled", async () => {
    h.state.counts = [0, 0];
    await backfillEmailsForContact("u-1", 42, ["amy@y.com"], { backfilledAt: null });

    const stamps = stampUpdates();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].filters).toContainEqual(["is", "email_backfilled_at", null]);
  });

  it("holds the stamp when a claim write fails, so the next call retries", async () => {
    h.state.failUpdatesOn = new Set(["email_messages"]);
    await backfillEmailsForContact("u-1", 42, ["amy@y.com"], { backfilledAt: null });

    expect(claimUpdates().length).toBeGreaterThan(0);
    expect(stampUpdates()).toHaveLength(0);
  });
});

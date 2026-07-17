/**
 * CAR-139 hot patch: the relationship-health surfaces cover the active
 * network only. getHomeCoreData already filtered network_status=active, but
 * getRelationshipsOnTrack and getContactsWithLastTouch did not — imported
 * prospects/bench contacts (no touches, no cadence) were deflating the
 * "Relationships on track" percentage and polluting the health grid in
 * production. These tests pin the filter on both queries.
 *
 * Mirrors the active-only pattern of home-recent-contacts-active-only.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface QueryState {
  table: string;
  filters: Array<{ method: string; args: unknown[] }>;
}

const h = vi.hoisted(() => {
  const state: { calls: QueryState[] } = { calls: [] };

  function makeBuilder(table: string) {
    const qs: QueryState = { table, filters: [] };
    state.calls.push(qs);
    const resolve = () => ({ data: null, count: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      qs.filters.push({ method, args });
      return builder;
    };
    Object.assign(builder, {
      select: chain("select"),
      eq: chain("eq"), neq: chain("neq"), or: chain("or"), in: chain("in"), is: chain("is"),
      not: chain("not"), gt: chain("gt"), gte: chain("gte"), lt: chain("lt"), lte: chain("lte"),
      order: chain("order"), limit: chain("limit"), range: chain("range"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({ from: (t: string) => h.makeBuilder(t) }),
}));

import { getContactsWithLastTouch, getRelationshipsOnTrack } from "@/lib/queries";

const hasActiveFilter = (q: QueryState) =>
  q.filters.some((f) => f.method === "eq" && JSON.stringify(f.args) === JSON.stringify(["network_status", "active"]));

beforeEach(() => {
  h.state.calls = [];
});

describe("relationship health queries cover the active network only (CAR-139)", () => {
  it("getContactsWithLastTouch filters contacts to network_status=active", async () => {
    await getContactsWithLastTouch("user-1");
    const contactsQuery = h.state.calls.find((q) => q.table === "contacts");
    expect(contactsQuery).toBeDefined();
    expect(hasActiveFilter(contactsQuery!)).toBe(true);
  });

  it("getRelationshipsOnTrack filters contacts to network_status=active", async () => {
    await getRelationshipsOnTrack("user-1");
    const contactsQuery = h.state.calls.find((q) => q.table === "contacts");
    expect(contactsQuery).toBeDefined();
    expect(hasActiveFilter(contactsQuery!)).toBe(true);
  });
});

/**
 * Home page "Contacts added" KPI (and the Recently Added height predictor)
 * count the active network only. Imported prospects/bench are not contacts
 * the user added, so they must never inflate the recently-added counts, and
 * the KPI must stay consistent with the active-only Recently Added list.
 *
 * Mirrors the active-only guarantee locked in for change events
 * (change-events-active-only.test.ts), applied to the home stat surfaces.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface QueryState {
  table: string;
  filters: Array<{ method: string; args: unknown[] }>;
}

// ── Chained-builder mock over the module-level browser client ──
// queries.ts binds `const supabase = createSupabaseBrowserClient()` once at
// import, so the mock returns a stable client whose `from()` records every
// filter in shared hoisted state that each test resets.
const h = vi.hoisted(() => {
  const state: {
    calls: QueryState[];
    respond: (q: QueryState) => { count?: number } | undefined;
  } = { calls: [], respond: () => undefined };

  function makeBuilder(table: string) {
    const qs: QueryState = { table, filters: [] };
    state.calls.push(qs);
    const resolve = () => {
      const r = state.respond(qs) ?? {};
      return { data: null, count: r.count ?? null, error: null };
    };
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

import { getHomeStats, getActionListCounts } from "@/lib/queries";

const filtersOf = (q: QueryState, method: string) =>
  q.filters.filter((f) => f.method === method).map((f) => f.args);
const hasFilter = (q: QueryState, method: string, args: unknown[]) =>
  filtersOf(q, method).some((a) => JSON.stringify(a) === JSON.stringify(args));
const isActiveOnly = (q: QueryState) => hasFilter(q, "eq", ["network_status", "active"]);
// The recently-added window is the contacts query bounded by created_at.
const boundsCreatedAt = (q: QueryState) =>
  filtersOf(q, "gte").some(([col]) => col === "created_at");

beforeEach(() => {
  h.state.calls = [];
  h.state.respond = () => undefined;
});

describe("getHomeStats — Contacts added KPI counts the active network only", () => {
  it("restricts both the current and previous recently-added counts to network_status=active", async () => {
    h.state.respond = (q) => {
      if (q.table !== "contacts") return undefined;
      // The previous 7-day window carries an upper bound (lt on created_at);
      // the current window is open-ended.
      const isPrevious = filtersOf(q, "lt").some(([col]) => col === "created_at");
      return { count: isPrevious ? 2 : 5 };
    };

    const stats = await getHomeStats("user-1");

    const recentCountQueries = h.state.calls.filter((q) => q.table === "contacts" && boundsCreatedAt(q));
    expect(recentCountQueries).toHaveLength(2); // current + previous windows
    for (const q of recentCountQueries) {
      expect(isActiveOnly(q)).toBe(true);
    }

    // Prospects/bench excluded, but the counts still flow through untouched.
    expect(stats.contactsAdded).toEqual({ current: 5, previous: 2 });
  });
});

describe("getActionListCounts — Recently Added height predictor counts the active network only", () => {
  it("restricts the recently-added contacts count to network_status=active", async () => {
    await getActionListCounts("user-1");

    const recentQuery = h.state.calls.find((q) => q.table === "contacts" && boundsCreatedAt(q));
    expect(recentQuery).toBeDefined();
    expect(isActiveOnly(recentQuery!)).toBe(true);
  });
});

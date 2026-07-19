/**
 * Deep-review regression pins for the CAR-146 data layer (PR #112):
 *
 * - buildLastTouchMap paginates INSIDE each id chunk: 200 contacts can carry
 *   more than 1000 touches between them, and PostgREST truncates silently at
 *   its row cap — the max-date merge must see rows past the first page.
 * - getActivityHeatmap buckets interactions by day: interaction_date is
 *   timestamptz, so the bucket key must be trimmed to YYYY-MM-DD (untrimmed,
 *   interactions never matched a day and were silently dropped).
 * - getActionItems paginates: MCP's listActionItems narrows by
 *   direction/contact/due in memory AFTER this fetch, so a truncated first
 *   page under-returns whole slices of the tool's result (CAR-151).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface Call {
  table: string;
  ops: Array<{ m: string; args: unknown[] }>;
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    respond: (_c: Call): { data: unknown; error: unknown } => ({ data: [], error: null }),
  };

  function makeBuilder(table: string) {
    const call: Call = { table, ops: [] };
    state.calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = (m: string) => (...args: unknown[]) => {
      call.ops.push({ m, args });
      return builder;
    };
    for (const m of ["select", "insert", "update", "delete", "eq", "is", "in", "order", "limit", "range", "or", "not", "gte", "lt"]) {
      builder[m] = chain(m);
    }
    builder.single = async () => state.respond(call);
    builder.maybeSingle = async () => state.respond(call);
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(state.respond(call)).then(onF, onR);
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({ from: (t: string) => h.makeBuilder(t) }),
}));

import { buildLastTouchMap } from "@/lib/data/follow-ups";
import { getActivityHeatmap } from "@/lib/data/home";
import { getActionItems } from "@/lib/data/action-items";

const rangeArgs = (c: Call) => c.ops.find((o) => o.m === "range")?.args as [number, number] | undefined;

beforeEach(() => {
  h.state.calls = [];
  h.state.respond = () => ({ data: [], error: null });
});

describe("buildLastTouchMap chunk pagination", () => {
  it("pages past the 1000-row cap inside a chunk and merges the max date from a later page", async () => {
    h.state.respond = (c) => {
      if (c.table === "meeting_contacts") {
        const r = rangeArgs(c);
        if (r?.[0] === 0) {
          // Full first page: 1000 older touches for the same contact.
          return {
            data: Array.from({ length: 1000 }, () => ({
              contact_id: 1,
              meetings: { meeting_date: "2026-01-01" },
            })),
            error: null,
          };
        }
        // Short second page carries the latest touch — only visible if the
        // query paginates instead of stopping at the capped first response.
        return { data: [{ contact_id: 1, meetings: { meeting_date: "2026-07-15" } }], error: null };
      }
      return { data: [], error: null };
    };

    const map = await buildLastTouchMap("user-1", [1]);
    expect(map.get(1)).toBe("2026-07-15");

    // Two windows were requested for meeting_contacts: [0,999] then [1000,1999].
    const windows = h.state.calls.filter((c) => c.table === "meeting_contacts").map(rangeArgs);
    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
    ]);

    // Stable pagination order: meeting_contacts has no id column, so the
    // (contact_id, meeting_id) composite is the ordering key.
    const first = h.state.calls.find((c) => c.table === "meeting_contacts")!;
    const orders = first.ops.filter((o) => o.m === "order").map((o) => o.args[0]);
    expect(orders).toEqual(["contact_id", "meeting_id"]);
  });

  it("returns an empty map without querying for an empty id list", async () => {
    const map = await buildLastTouchMap("user-1", []);
    expect(map.size).toBe(0);
    expect(h.state.calls).toHaveLength(0);
  });
});

describe("getActivityHeatmap interaction bucketing", () => {
  it("counts a timestamptz interaction in its YYYY-MM-DD day bucket", async () => {
    // Noon UTC three days ago: its UTC date equals the local date for any
    // timezone within ±12h, keeping the axis lookup deterministic.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 3);
    d.setUTCHours(12, 0, 0, 0);
    const iso = d.toISOString(); // e.g. 2026-07-14T12:00:00.000Z
    const day = iso.split("T")[0];

    h.state.respond = (c) => {
      if (c.table === "interactions") {
        const r = rangeArgs(c);
        // One interaction on the first page, then the pagination stops.
        return r?.[0] === 0 ? { data: [{ interaction_date: iso }], error: null } : { data: [], error: null };
      }
      return { data: [], error: null };
    };

    const result = await getActivityHeatmap("u1");
    const bucket = result.find((r) => r.date === day);
    expect(bucket).toBeDefined();
    expect(bucket!.conversations).toBe(1);
    expect(bucket!.count).toBe(1);
  });
});

describe("getActionItems pagination", () => {
  it("pages past the 1000-row cap so in-memory narrowing sees every pending item", async () => {
    h.state.respond = (c) => {
      if (c.table === "follow_up_action_items") {
        const r = rangeArgs(c);
        if (r?.[0] === 0) {
          return {
            data: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, direction: "my_task" })),
            error: null,
          };
        }
        // MCP's listActionItems filters by direction AFTER this fetch, so a
        // waiting_on item stranded past the cap would silently disappear.
        return { data: [{ id: 1001, direction: "waiting_on" }], error: null };
      }
      return { data: [], error: null };
    };

    const rows = await getActionItems("u1");
    expect(rows).toHaveLength(1001);
    expect(rows.some((r: { id: number }) => r.id === 1001)).toBe(true);

    const windows = h.state.calls.filter((c) => c.table === "follow_up_action_items").map(rangeArgs);
    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
    ]);

    // due_at is nullable and heavily duplicated, so id is the stable
    // tiebreaker range pagination needs to avoid dropping/repeating rows.
    const first = h.state.calls.find((c) => c.table === "follow_up_action_items")!;
    const orders = first.ops.filter((o) => o.m === "order").map((o) => o.args[0]);
    expect(orders).toEqual(["due_at", "id"]);
  });
});

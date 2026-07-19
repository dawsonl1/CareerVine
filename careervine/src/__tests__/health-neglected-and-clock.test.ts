/**
 * Deep-review regression pins for the CAR-151 reach-out/health surfaces:
 *
 * - getNeglectedContacts honors first_outreach_skipped, but only for people
 *   who were never contacted. The flag is an opt-out of the FIRST-outreach
 *   nag; someone already contacted stays legitimately neglectable, matching
 *   deriveDueFollowUps' canonical gate.
 * - getContactsWithLastTouch paginates instead of capping at 500. Its sibling
 *   getRelationshipsOnTrack is unbounded, so a cap made getNetworkHealth pair
 *   a whole-network on-track ratio with an alphabetically-truncated list.
 * - deriveDueFollowUps derives its entire clock from the passed nowIso, so
 *   one response cannot evaluate followUps against a later instant than its
 *   sibling outputs (and the function is deterministic under test).
 *
 * Harness mirrors data-scale-regressions.test.ts.
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

import {
  getContactsWithLastTouch,
  getNeglectedContacts,
} from "@/lib/data/follow-ups";
import { deriveDueFollowUps, type DueFollowUpSourceRow } from "@/lib/rules/due-follow-ups";

const rangeArgs = (c: Call) => c.ops.find((o) => o.m === "range")?.args as [number, number] | undefined;

/** Serve `rows` as the first contacts page; every other table reads empty. */
function serveContacts(rows: unknown[], touches: unknown[] = []) {
  h.state.respond = (c) => {
    const r = rangeArgs(c);
    const firstPage = !r || r[0] === 0;
    if (c.table === "contacts") return { data: firstPage ? rows : [], error: null };
    if (c.table === "meeting_contacts") return { data: firstPage ? touches : [], error: null };
    return { data: [], error: null };
  };
}

beforeEach(() => {
  h.state.calls = [];
  h.state.respond = () => ({ data: [], error: null });
});

describe("getNeglectedContacts honors the first-outreach opt-out", () => {
  const base = { industry: null, photo_url: null, created_at: "2020-01-01T00:00:00.000Z", network_status: "active" };

  it("omits a never-contacted contact the user explicitly skipped", async () => {
    serveContacts([
      { id: 1, name: "Skipped Sam", follow_up_frequency_days: 30, first_outreach_skipped: true, ...base },
      { id: 2, name: "Untouched Uma", follow_up_frequency_days: 30, first_outreach_skipped: false, ...base },
    ]);

    const neglected = await getNeglectedContacts("user-1");
    expect(neglected.map((c) => c.id)).toEqual([2]);
  });

  it("keeps an overdue contact that HAS been contacted even when the flag is set", async () => {
    // The flag only ever silenced the first-outreach nag, so an unconditional
    // exclusion here would hide a real, long-neglected relationship.
    serveContacts(
      [{ id: 3, name: "Lapsed Lee", follow_up_frequency_days: 30, first_outreach_skipped: true, ...base }],
      [{ contact_id: 3, meetings: { meeting_date: "2020-06-01" } }],
    );

    const neglected = await getNeglectedContacts("user-1");
    expect(neglected.map((c) => c.id)).toEqual([3]);
  });
});

describe("getContactsWithLastTouch population", () => {
  it("paginates the contacts read instead of capping it, ordered by name then id", async () => {
    h.state.respond = (c) => {
      if (c.table !== "contacts") return { data: [], error: null };
      const r = rangeArgs(c);
      if (r?.[0] === 0) {
        return {
          data: Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `Contact ${i}`,
            industry: null,
            photo_url: null,
            follow_up_frequency_days: null,
            created_at: "2020-01-01T00:00:00.000Z",
            first_outreach_skipped: false,
          })),
          error: null,
        };
      }
      // Short second page: only reachable if the query pages past the cap.
      return {
        data: [{
          id: 1001, name: "Zed", industry: null, photo_url: null,
          follow_up_frequency_days: null, created_at: "2020-01-01T00:00:00.000Z",
          first_outreach_skipped: false,
        }],
        error: null,
      };
    };

    const contacts = await getContactsWithLastTouch("user-1");
    expect(contacts).toHaveLength(1001);

    const contactCalls = h.state.calls.filter((c) => c.table === "contacts");
    expect(contactCalls.map(rangeArgs)).toEqual([[0, 999], [1000, 1999]]);
    expect(contactCalls[0].ops.some((o) => o.m === "limit")).toBe(false);
    expect(contactCalls[0].ops.filter((o) => o.m === "order").map((o) => o.args[0])).toEqual(["name", "id"]);
  });
});

describe("deriveDueFollowUps derives its whole clock from nowIso", () => {
  const row = (over: Partial<DueFollowUpSourceRow> = {}): DueFollowUpSourceRow => ({
    id: 1,
    name: "Nora",
    industry: null,
    follow_up_frequency_days: null,
    photo_url: null,
    created_at: "2026-03-10T00:00:00.000Z",
    first_outreach_skipped: null,
    reach_out_snoozed_until: null,
    network_status: "active",
    contact_emails: null,
    ...over,
  });

  it("applies the Recently Added window relative to nowIso, not wall-clock now", async () => {
    // Created one day before nowIso: recent on that clock, ancient on today's.
    // With an internally recomputed cutoff this surfaces as a no-cadence nag.
    const out = deriveDueFollowUps([row()], new Map(), "2026-03-11T12:00:00.000Z");
    expect(out).toEqual([]);
  });

  it("advances days_overdue with nowIso rather than with wall-clock now", async () => {
    const contacts = [row({ follow_up_frequency_days: 10 })];
    const earlier = deriveDueFollowUps(contacts, new Map(), "2026-04-10T12:00:00.000Z");
    const later = deriveDueFollowUps(contacts, new Map(), "2026-04-20T12:00:00.000Z");
    expect(earlier).toHaveLength(1);
    expect(earlier[0].never_contacted).toBe(true);
    // Both sides read local midnight off their own nowIso, so the delta is
    // exactly the 10 days between them in any timezone.
    expect(later[0].days_overdue - earlier[0].days_overdue).toBe(10);
  });

  it("is deterministic: the same inputs and nowIso yield an identical result", async () => {
    const contacts = [
      row({ id: 1, follow_up_frequency_days: 10 }),
      row({ id: 2, name: "Owen", follow_up_frequency_days: 5, created_at: "2026-01-01T00:00:00.000Z" }),
      row({ id: 3, name: "Pia", reach_out_snoozed_until: "2026-05-01T00:00:00.000Z" }),
    ];
    const nowIso = "2026-04-10T12:00:00.000Z";
    const touches = new Map([[2, "2026-02-01"]]);

    expect(deriveDueFollowUps(contacts, touches, nowIso)).toEqual(
      deriveDueFollowUps(contacts, touches, nowIso),
    );
  });
});

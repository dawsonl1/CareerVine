import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-132: the MCP cancel helpers use a count-based CAS instead of a .select()
 * read-back, and cancelScheduledEmail writes 'cancelled' — NOT 'cancelled_user',
 * which the scheduled_emails CHECK rejects (every MCP scheduled-email cancel
 * 23514'd in production until this fix).
 */

type RecordedUpdate = {
  table: string;
  patch: Record<string, unknown>;
  countRequested: boolean;
  ins: Array<[string, unknown[]]>;
};

const state: {
  updates: RecordedUpdate[];
  results: { count: number | null; error: unknown }[];
  /** Per-table rows returned by reads (e.g. the linked-followup lookup). */
  readData: Record<string, unknown[]>;
} = { updates: [], results: [], readData: {} };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      let mode: "read" | "update" = "read";
      let recorded: RecordedUpdate | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Record<string, unknown>, opts?: { count?: string }) => {
          mode = "update";
          recorded = { table, patch, countRequested: opts?.count === "exact", ins: [] };
          state.updates.push(recorded);
          return b;
        },
        eq: () => b,
        in: (col: string, vals: unknown[]) => {
          recorded?.ins.push([col, vals]);
          return b;
        },
        then: (resolve: (v: unknown) => void) => {
          if (mode === "update") return resolve(state.results.shift() ?? { count: 1, error: null });
          return resolve({ data: state.readData[table] ?? [], error: null });
        },
      };
      return b;
    },
  }),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
  checkContactMilestone: async () => {},
}));

import { initDb, cancelScheduledEmail, cancelFollowUpSequence } from "@/mcp/lib/db";

describe("MCP cancel helpers — count-based CAS (CAR-132)", () => {
  beforeEach(() => {
    state.updates = [];
    state.results = [];
    state.readData = {};
    initDb("user-1");
  });

  it("cancelScheduledEmail writes 'cancelled' (CHECK-valid), count=1 succeeds", async () => {
    state.results = [{ count: 1, error: null }];

    await expect(cancelScheduledEmail(7)).resolves.toBeUndefined();

    expect(state.updates).toHaveLength(1);
    const u = state.updates[0];
    expect(u.table).toBe("scheduled_emails");
    expect(u.patch.status).toBe("cancelled"); // 'cancelled_user' violates the DB CHECK
    expect(u.countRequested).toBe(true);
  });

  it("cancelScheduledEmail throws when no pending row matched (count=0)", async () => {
    state.results = [{ count: 0, error: null }];

    await expect(cancelScheduledEmail(7)).rejects.toThrow(/No cancellable scheduled email/);
  });

  it("cancelFollowUpSequence count=1 -> also cancels the child messages", async () => {
    state.results = [
      { count: 1, error: null }, // parent CAS
      { count: null, error: null }, // child-message cancel
    ];

    await expect(cancelFollowUpSequence(3)).resolves.toBeUndefined();

    expect(state.updates.map((u) => u.table)).toEqual(["email_follow_ups", "email_follow_up_messages"]);
    expect(state.updates[0].patch.status).toBe("cancelled_user"); // valid on email_follow_ups
    expect(state.updates[0].countRequested).toBe(true);
    expect(state.updates[1].patch.status).toBe("cancelled");
  });

  it("cancelFollowUpSequence count=0 -> throws and leaves child messages untouched", async () => {
    state.results = [{ count: 0, error: null }];

    await expect(cancelFollowUpSequence(3)).rejects.toThrow(/No active follow-up sequence/);
    expect(state.updates).toHaveLength(1); // no second (child) update
  });

  // CAR-136: cancelScheduledEmail must also tear down follow-up sequences
  // linked via scheduled_email_id, like the web DELETE route — otherwise they
  // stay active and fire into a thread whose opening email never sent.
  it("cancelScheduledEmail cancels linked follow-up sequences and their messages", async () => {
    state.readData = { email_follow_ups: [{ id: 3 }, { id: 4 }] };
    state.results = [
      { count: 1, error: null }, // scheduled email CAS
      { count: null, error: null }, // child-message cancel
      { count: null, error: null }, // parent sequence cancel
    ];

    await expect(cancelScheduledEmail(7)).resolves.toBeUndefined();

    expect(state.updates.map((u) => u.table)).toEqual([
      "scheduled_emails",
      "email_follow_up_messages",
      "email_follow_ups",
    ]);
    const msgUpdate = state.updates[1];
    expect(msgUpdate.patch.status).toBe("cancelled");
    expect(msgUpdate.ins).toContainEqual(["follow_up_id", [3, 4]]);
    // Expired steps are still one-click sendable (CAR-105) — they must be
    // included in the teardown or they'd be orphaned under a cancelled parent.
    const statusIn = msgUpdate.ins.find(([col]) => col === "status");
    expect(statusIn?.[1]).toContain("expired");
    expect(statusIn?.[1]).toContain("pending");
    const parentUpdate = state.updates[2];
    expect(parentUpdate.patch.status).toBe("cancelled_user");
    expect(parentUpdate.ins).toContainEqual(["id", [3, 4]]);
  });

  it("cancelScheduledEmail with no linked sequences only touches the scheduled email", async () => {
    state.results = [{ count: 1, error: null }];

    await expect(cancelScheduledEmail(7)).resolves.toBeUndefined();

    expect(state.updates.map((u) => u.table)).toEqual(["scheduled_emails"]);
  });

  it("cancelScheduledEmail leaves linked sequences alone when the CAS loses (count=0)", async () => {
    state.readData = { email_follow_ups: [{ id: 3 }] };
    state.results = [{ count: 0, error: null }];

    await expect(cancelScheduledEmail(7)).rejects.toThrow(/No cancellable scheduled email/);
    expect(state.updates).toHaveLength(1); // no follow-up teardown
  });
});

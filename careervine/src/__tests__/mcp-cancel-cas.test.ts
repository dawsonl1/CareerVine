import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-132: the MCP cancel helpers use a count-based CAS instead of a .select()
 * read-back, and cancelScheduledEmail writes 'cancelled' — NOT 'cancelled_user',
 * which the scheduled_emails CHECK rejects (every MCP scheduled-email cancel
 * 23514'd in production until this fix).
 */

type RecordedUpdate = { table: string; patch: Record<string, unknown>; countRequested: boolean };

const state: {
  updates: RecordedUpdate[];
  results: { count: number | null; error: unknown }[];
} = { updates: [], results: [] };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      let mode: "read" | "update" = "read";
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Record<string, unknown>, opts?: { count?: string }) => {
          mode = "update";
          state.updates.push({ table, patch, countRequested: opts?.count === "exact" });
          return b;
        },
        eq: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => void) => {
          if (mode === "update") return resolve(state.results.shift() ?? { count: 1, error: null });
          return resolve({ data: [], error: null });
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

    await expect(cancelScheduledEmail(7)).rejects.toThrow(/No pending scheduled email/);
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
});

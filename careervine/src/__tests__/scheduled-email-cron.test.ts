import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";

/**
 * Table-aware chained-builder mock: scheduled_emails returns the due rows,
 * users returns the active-status rows the suspension guard filters by.
 */
function mockService(
  scheduledRows: Array<{ user_id: string; scheduled_send_at: string }>,
  opts: { suspendedUserIds?: string[] } = {},
): SupabaseClient {
  const suspended = new Set(opts.suspendedUserIds ?? []);

  function makeBuilder(table: string) {
    const builder: Record<string, unknown> = {};
    const resolveData = () => {
      if (table === "users") {
        const ids = [...new Set(scheduledRows.map((r) => r.user_id))]
          .filter((id) => !suspended.has(id))
          .map((id) => ({ id }));
        return { data: ids, error: null };
      }
      return { data: scheduledRows, error: null };
    };
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolveData()).then(resolve),
    });
    return builder;
  }

  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
}

describe("processDueScheduledEmails", () => {
  it("returns zeroes when there are no due rows", async () => {
    const result = await processDueScheduledEmails("2026-01-01T00:00:00.000Z", {
      service: mockService([]),
      processForUser: vi.fn(),
    });
    expect(result).toEqual({
      dueRows: 0,
      usersProcessed: 0,
      usersFailed: 0,
      sent: 0,
      errors: 0,
      durationMs: expect.any(Number),
      oldestDueScheduledAt: null,
      maxDelayMs: 0,
      throughputEmailsPerMinute: 0,
      capacityStatus: "healthy",
    });
  });

  it("deduplicates user ids and aggregates send results", async () => {
    const processForUser = vi
      .fn<(userId: string) => Promise<{ sent: number; errors: number }>>()
      .mockResolvedValueOnce({ sent: 2, errors: 0 })
      .mockResolvedValueOnce({ sent: 1, errors: 1 });
    const result = await processDueScheduledEmails("2026-01-01T00:00:00.000Z", {
      service: mockService([
        { user_id: "u1", scheduled_send_at: "2025-12-31T23:30:00.000Z" },
        { user_id: "u1", scheduled_send_at: "2025-12-31T23:40:00.000Z" },
        { user_id: "u2", scheduled_send_at: "2025-12-31T23:45:00.000Z" },
      ]),
      processForUser,
    });

    expect(processForUser).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      dueRows: 3,
      usersProcessed: 2,
      usersFailed: 0,
      sent: 3,
      errors: 1,
      durationMs: expect.any(Number),
      oldestDueScheduledAt: "2025-12-31T23:30:00.000Z",
      maxDelayMs: 30 * 60 * 1000,
      throughputEmailsPerMinute: expect.any(Number),
      capacityStatus: "at_risk",
    });
  });

  it("continues processing after a user-level failure", async () => {
    const processForUser = vi
      .fn<(userId: string) => Promise<{ sent: number; errors: number }>>()
      .mockRejectedValueOnce(new Error("gmail disconnected"))
      .mockResolvedValueOnce({ sent: 1, errors: 0 });
    const result = await processDueScheduledEmails("2026-01-01T00:00:00.000Z", {
      service: mockService([
        { user_id: "u1", scheduled_send_at: "2025-12-31T23:00:00.000Z" },
        { user_id: "u2", scheduled_send_at: "2025-12-31T23:59:00.000Z" },
      ]),
      processForUser,
    });

    expect(result).toEqual({
      dueRows: 2,
      usersProcessed: 1,
      usersFailed: 1,
      sent: 1,
      errors: 0,
      durationMs: expect.any(Number),
      oldestDueScheduledAt: "2025-12-31T23:00:00.000Z",
      maxDelayMs: 60 * 60 * 1000,
      throughputEmailsPerMinute: expect.any(Number),
      capacityStatus: "overloaded",
    });
  });

  it("holds (never sends) a suspended user's due emails and keeps them out of capacity telemetry", async () => {
    const processForUser = vi
      .fn<(userId: string) => Promise<{ sent: number; errors: number }>>()
      .mockResolvedValue({ sent: 1, errors: 0 });
    const result = await processDueScheduledEmails("2026-01-01T00:00:00.000Z", {
      service: mockService(
        [
          // Suspended user's email is 3 days overdue — must not send and must
          // not flip capacityStatus to overloaded.
          { user_id: "suspended-1", scheduled_send_at: "2025-12-29T00:00:00.000Z" },
          { user_id: "u2", scheduled_send_at: "2025-12-31T23:55:00.000Z" },
        ],
        { suspendedUserIds: ["suspended-1"] },
      ),
      processForUser,
    });

    expect(processForUser).toHaveBeenCalledTimes(1);
    expect(processForUser).toHaveBeenCalledWith("u2");
    expect(result.dueRows).toBe(1);
    expect(result.oldestDueScheduledAt).toBe("2025-12-31T23:55:00.000Z");
    expect(result.capacityStatus).toBe("healthy");
  });

  it("returns zeroes when every due user is suspended", async () => {
    const processForUser = vi.fn();
    const result = await processDueScheduledEmails("2026-01-01T00:00:00.000Z", {
      service: mockService(
        [{ user_id: "suspended-1", scheduled_send_at: "2025-12-31T23:00:00.000Z" }],
        { suspendedUserIds: ["suspended-1"] },
      ),
      processForUser,
    });

    expect(processForUser).not.toHaveBeenCalled();
    expect(result.dueRows).toBe(0);
    expect(result.capacityStatus).toBe("healthy");
  });
});

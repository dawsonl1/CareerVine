/**
 * CAR-206 at the MCP surface, which carried the worst variant of the bug.
 *
 * `listActionItems` filtered with `new Date(due_at) < startOfToday`. `due_at`
 * is a calendar date stored as midnight UTC, so that comparison was true for
 * everything due TODAY for any operator at or west of UTC: `due: "overdue"`
 * reported today's items as overdue, all day, every day. The `today` window had
 * the mirror-image error and included tomorrow's.
 *
 * The zone is pinned per case because the defect is asymmetric — see
 * `src/__tests__/due-date.test.ts` for the same reasoning at the unit level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockServiceClientModule } from "../../__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "../../__tests__/helpers/mock-analytics";
import { typedMock } from "../../__tests__/helpers/typed-mock";

const rows = vi.hoisted(() => ({ current: [] as unknown[] }));

/** Captures what the write paths actually persist. */
const writes = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
}));

/**
 * Minimal recording client for the one raw query MCP's updateActionItem issues:
 * .from().update().eq().eq().select(). The data layer is mocked wholesale for
 * the create path, so this only has to satisfy the update chain.
 */
const recordingClient = () => ({
  from: () => ({
    update: (payload: Record<string, unknown>) => {
      writes.updated.push(payload);
      const chain = {
        eq: () => chain,
        select: async () => ({ data: [{ id: 7 }], error: null }),
      };
      return chain;
    },
  }),
});

vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => recordingClient()));
vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule());
vi.mock("@/mcp/user-context", () =>
  typedMock<typeof import("@/mcp/user-context")>({
    currentUserIdOrNull: vi.fn(() => "user-1"),
    runWithUser: vi.fn(),
    runWithUserAsync: vi.fn(),
    requireRequestUserId: vi.fn(() => "user-1"),
  }),
);
vi.mock("@/lib/data/action-items", () =>
  typedMock<typeof import("@/lib/data/action-items")>({
    getActionItems: vi.fn(async () => rows.current as never),
    createActionItem: vi.fn(async (payload: Record<string, unknown>) => {
      writes.created.push(payload);
      return { id: 99, ...payload } as never;
    }),
    getActionItemsForMeeting: vi.fn(),
    getActionItemsForMeetings: vi.fn(),
    getActionItemsForContact: vi.fn(),
    getCompletedActionItems: vi.fn(),
    getCompletedActionItemsForContact: vi.fn(),
    replaceContactsForActionItem: vi.fn(),
    deleteActionItem: vi.fn(),
    getOnboardingActionItemId: vi.fn(),
    updateActionItem: vi.fn(),
    snoozeActionItem: vi.fn(),
  }),
);

import { createActionItem, listActionItems, updateActionItem } from "@/mcp/lib/db";
import { handler } from "@/mcp/lib/tool-utils";

function item(id: number, due_at: string | null) {
  return {
    id,
    title: `item ${id}`,
    description: null,
    due_at,
    is_completed: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
    direction: "my_task",
    snoozed_until: null,
    action_item_contacts: [],
  };
}

const YESTERDAY = "2026-01-04T00:00:00+00:00";
const TODAY = "2026-01-05T00:00:00+00:00";
const TOMORROW = "2026-01-06T00:00:00+00:00";
const NEXT_WEEK = "2026-01-20T00:00:00+00:00";

const originalTz = process.env.TZ;

function pin(tz: string, isoInstant: string) {
  process.env.TZ = tz;
  vi.setSystemTime(new Date(isoInstant));
}

beforeEach(() => {
  vi.useFakeTimers();
  writes.created.length = 0;
  writes.updated.length = 0;
  rows.current = [
    item(1, YESTERDAY),
    item(2, TODAY),
    item(3, TOMORROW),
    item(4, NEXT_WEEK),
    item(5, null),
  ];
});

afterEach(() => {
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const ids = (items: Array<{ id: number }>) => items.map((i) => i.id).sort((a, b) => a - b);

describe("listActionItems due windows (CAR-206)", () => {
  it.each([
    ["America/Denver", "2026-01-05T18:00:00-07:00"],
    ["America/Denver", "2026-01-05T09:00:00-07:00"],
    ["America/Los_Angeles", "2026-01-05T16:59:00-08:00"],
    ["UTC", "2026-01-05T09:00:00Z"],
    ["Pacific/Auckland", "2026-01-05T09:00:00+13:00"],
  ])("overdue excludes items due today — %s at %s", async (tz, now) => {
    pin(tz, now);
    expect(ids(await listActionItems({ due: "overdue" }))).toEqual([1]);
  });

  it.each([
    ["America/Denver", "2026-01-05T18:00:00-07:00"],
    ["UTC", "2026-01-05T09:00:00Z"],
    ["Pacific/Auckland", "2026-01-05T09:00:00+13:00"],
  ])("today includes today and earlier, never tomorrow — %s at %s", async (tz, now) => {
    pin(tz, now);
    expect(ids(await listActionItems({ due: "today" }))).toEqual([1, 2]);
  });

  it.each([
    ["America/Denver", "2026-01-05T18:00:00-07:00"],
    ["UTC", "2026-01-05T09:00:00Z"],
    ["Pacific/Auckland", "2026-01-05T09:00:00+13:00"],
  ])("week spans the next seven days inclusive — %s at %s", async (tz, now) => {
    pin(tz, now);
    // 2026-01-11 is the last day in the window; 2026-01-20 is outside it.
    rows.current = [...rows.current, item(6, "2026-01-11T00:00:00+00:00"), item(7, "2026-01-12T00:00:00+00:00")];
    expect(ids(await listActionItems({ due: "week" }))).toEqual([1, 2, 3, 6]);
  });

  it("all returns everything, including items with no due date", async () => {
    pin("America/Denver", "2026-01-05T18:00:00-07:00");
    expect(ids(await listActionItems({ due: "all" }))).toEqual([1, 2, 3, 4, 5]);
  });

  it("the overdue set does not change as the local clock crosses UTC midnight", async () => {
    const at = async (now: string) => {
      pin("America/Denver", now);
      return ids(await listActionItems({ due: "overdue" }));
    };
    expect(await at("2026-01-05T09:00:00-07:00")).toEqual([1]);
    expect(await at("2026-01-05T16:59:00-07:00")).toEqual([1]);
    expect(await at("2026-01-05T18:00:00-07:00")).toEqual([1]);
    expect(await at("2026-01-05T23:30:00-07:00")).toEqual([1]);
  });
});

/**
 * The WRITE half of CAR-206, which shipped with no coverage at all and is the
 * half that can corrupt data. `normalizeDueDate` introduced both a new throw and
 * a new coercion, and the absence of any test here is why an empty string
 * silently wiping a due date got as far as review.
 */
describe("MCP due_at write normalization (CAR-206)", () => {
  beforeEach(() => {
    pin("America/Denver", "2026-01-05T09:00:00-07:00");
  });

  const lastCreated = () => writes.created.at(-1);
  const lastUpdated = () => writes.updated.at(-1);

  it("stores a plain date unchanged", async () => {
    await createActionItem({ title: "t", due_at: "2026-01-05", contactIds: [] });
    expect(lastCreated()?.due_at).toBe("2026-01-05");
  });

  it("truncates an offset-bearing instant to the date the caller named", async () => {
    // The caller said Jan 5 at 17:00 their time. That instant is Jan 6 in UTC,
    // and pre-PR it was stored as such and then displayed as Jan 6.
    await createActionItem({ title: "t", due_at: "2026-01-05T17:00:00-07:00", contactIds: [] });
    expect(lastCreated()?.due_at).toBe("2026-01-05");
  });

  it("stores null when no due date is given", async () => {
    await createActionItem({ title: "t", contactIds: [] });
    expect(lastCreated()?.due_at).toBeNull();
  });

  it("rejects a value it cannot read as a date, and persists nothing", async () => {
    await expect(
      createActionItem({ title: "t", due_at: "next friday", contactIds: [] }),
    ).rejects.toThrow(/Invalid due date/);
    await expect(
      createActionItem({ title: "t", due_at: "2026-02-30", contactIds: [] }),
    ).rejects.toThrow(/Invalid due date/);
    expect(writes.created).toHaveLength(0);
  });

  it("rejects the empty string instead of silently clearing the due date", async () => {
    // The defect this test exists for. "" mapped to null, so an agent sending it
    // (an LLM's idea of "leave this field alone") wiped a due date and got a
    // success response back. Pre-PR "" reached PostgREST and failed with 22007,
    // so the update was refused and nothing was lost.
    await expect(updateActionItem(7, { due_at: "" })).rejects.toThrow(/Invalid due date/);
    expect(writes.updated).toHaveLength(0);
  });

  it("still clears the due date on an explicit null", async () => {
    await updateActionItem(7, { due_at: null });
    expect(lastUpdated()).toMatchObject({ due_at: null });
  });

  it("surfaces a rejection to the agent as a tool error, not an unhandled throw", async () => {
    const tool = handler(async () =>
      createActionItem({ title: "t", due_at: "whenever", contactIds: [] }),
    );
    const res = (await tool({})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid due date/);
  });
});

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

vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule());
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
    createActionItem: vi.fn(),
    getActionItemsForMeeting: vi.fn(),
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

import { listActionItems } from "@/mcp/lib/db";

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

// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-206, at the surface the ticket reproduced on.
 *
 * The module test (`due-date.test.ts`) pins the arithmetic. This one pins the
 * thing a user actually saw: the card and the edit modal disagreeing about the
 * same row, and the Overdue bucket reshuffling on the clock rather than on the
 * date. It renders the real `DatePicker`, because "card and modal agree" is
 * only meaningful if the modal's own formatting is in the loop.
 *
 * Timezone comes from `process.env.TZ` and the clock from `vi.setSystemTime`,
 * set before render. Both are needed: the bug is a disagreement between an
 * instant and a local calendar, so pinning one without the other cannot show it.
 */

const q = vi.hoisted(() => ({
  getActionItems: vi.fn(),
  getContacts: vi.fn(),
  getCompletedActionItems: vi.fn(),
  updateActionItem: vi.fn(),
  createActionItem: vi.fn(),
  deleteActionItem: vi.fn(),
  replaceContactsForActionItem: vi.fn(),
}));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/quick-capture-context", () => ({
  useQuickCapture: () => ({ open: vi.fn(), openEdit: vi.fn() }),
}));
vi.mock("@/hooks/use-suggestions", () => ({
  useSuggestions: () => ({
    suggestions: [],
    loading: false,
    failed: false,
    save: vi.fn(),
    complete: vi.fn(),
    dismiss: vi.fn(),
    triggerOnce: vi.fn(),
  }),
}));
vi.mock("@/lib/queries", () => q);

import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import ActionItemsPage from "@/app/action-items/page";

/** What PostgREST returns for a due date the user picked as 2026-01-05. */
const DUE_JAN_5 = "2026-01-05T00:00:00+00:00";
const DUE_JAN_4 = "2026-01-04T00:00:00+00:00";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Send Jane the deck",
    description: null,
    due_at: DUE_JAN_5,
    is_completed: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
    direction: "my_task",
    source: "manual",
    priority: null,
    contact_id: null,
    meeting_id: null,
    snoozed_until: null,
    contacts: null,
    meetings: null,
    action_item_contacts: [],
    ...overrides,
  };
}

const originalTz = process.env.TZ;

/** Pin zone and clock together, before the component reads either. */
function pin(tz: string, isoInstant: string) {
  process.env.TZ = tz;
  vi.setSystemTime(new Date(isoInstant));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  q.getContacts.mockResolvedValue([]);
  q.getCompletedActionItems.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("Action items — due date rendering (CAR-206)", () => {
  it.each([
    ["America/Denver", "2026-01-05T09:00:00-07:00"],
    ["America/Los_Angeles", "2026-01-05T09:00:00-08:00"],
    ["UTC", "2026-01-05T09:00:00Z"],
  ])("renders a 2026-01-05 due date as Jan 5 in %s", async (tz, now) => {
    pin(tz, now);
    q.getActionItems.mockResolvedValue([item()]);

    render(<ActionItemsPage />);

    await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());
    expect(screen.getByText("Due: Jan 5, 2026")).toBeTruthy();
  });

  // 09:00 local on 2026-01-05 in each zone, so the item is due-today everywhere
  // and the two renderings are compared under identical conditions.
  it.each([
    ["America/Denver", "2026-01-05T09:00:00-07:00"],
    ["America/Los_Angeles", "2026-01-05T09:00:00-08:00"],
    ["UTC", "2026-01-05T09:00:00Z"],
    ["Pacific/Auckland", "2026-01-05T09:00:00+13:00"],
  ])(
    "the card and the edit modal agree on the same row in %s",
    async (tz, now) => {
      pin(tz, now);
      q.getActionItems.mockResolvedValue([item()]);

      render(<ActionItemsPage />);
      await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());

      // The card renders through formatDueDate.
      expect(screen.getByText("Due: Jan 5, 2026")).toBeTruthy();

      // The edit modal seeds DatePicker with dueDateKey and the picker formats
      // it independently, parsing `value + "T00:00:00"` as LOCAL midnight. This
      // is the contradiction the ticket reproduced: the two must not disagree.
      fireEvent.click(screen.getByTitle("Edit"));
      await waitFor(() => expect(screen.getByText("Edit action item")).toBeTruthy());
      expect(screen.getByText("Jan 5, 2026")).toBeTruthy();
    },
  );
});

describe("Action items — overdue classification (CAR-206)", () => {
  it("an item due today is NOT overdue at 18:00 local", async () => {
    // The exact probe from the ticket: 18:00 Denver is already 2026-01-06 in
    // UTC, which is what flipped this item into Overdue every evening.
    pin("America/Denver", "2026-01-05T18:00:00-07:00");
    q.getActionItems.mockResolvedValue([item()]);

    render(<ActionItemsPage />);
    await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());

    expect(screen.getByText("Due: Jan 5, 2026")).toBeTruthy();
    expect(screen.queryByText("Overdue: Jan 5, 2026")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Overdue (1)" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Due this week (1)" })).toBeTruthy();
  });

  it("an item due yesterday IS overdue at 09:00 local", async () => {
    pin("America/Denver", "2026-01-05T09:00:00-07:00");
    q.getActionItems.mockResolvedValue([item({ due_at: DUE_JAN_4 })]);

    render(<ActionItemsPage />);
    await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());

    expect(screen.getByText("Overdue: Jan 4, 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Overdue (1)" })).toBeTruthy();
  });

  it("does not overcorrect east of UTC: an overdue item is still flagged", async () => {
    // Pacific/Auckland at 09:00 on 2026-01-06 is 2026-01-05 in UTC, so a UTC
    // "today" would have called this item due-today rather than overdue.
    pin("Pacific/Auckland", "2026-01-06T09:00:00+13:00");
    q.getActionItems.mockResolvedValue([item()]);

    render(<ActionItemsPage />);
    await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());

    expect(screen.getByText("Overdue: Jan 5, 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Overdue (1)" })).toBeTruthy();
  });

  it("classification does not change as the local clock crosses UTC midnight", async () => {
    const readBucket = async (now: string) => {
      pin("America/Denver", now);
      q.getActionItems.mockResolvedValue([item()]);
      render(<ActionItemsPage />);
      await waitFor(() => expect(screen.getByText("Send Jane the deck")).toBeTruthy());
      const overdue = screen.queryByRole("heading", { name: "Overdue (1)" }) !== null;
      cleanup();
      return overdue;
    };

    expect(await readBucket("2026-01-05T09:00:00-07:00")).toBe(false);
    expect(await readBucket("2026-01-05T16:59:00-07:00")).toBe(false);
    expect(await readBucket("2026-01-05T18:00:00-07:00")).toBe(false);
    expect(await readBucket("2026-01-05T23:30:00-07:00")).toBe(false);
  });
});

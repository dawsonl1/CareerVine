// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-154 / F21: the meetings page must toast (not silently swallow) a failed
 * action-item mutation, and must render a retryable error state when its list
 * fails to load rather than the "No activity yet" empty state.
 */

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const q = vi.hoisted(() => ({
  getMeetings: vi.fn(),
  deleteMeeting: vi.fn(),
  getContacts: vi.fn(),
  getActionItemsForMeeting: vi.fn(),
  updateActionItem: vi.fn(),
  deleteActionItem: vi.fn(),
  replaceContactsForActionItem: vi.fn(),
  getAllInteractions: vi.fn(),
  deleteInteraction: vi.fn(),
  uploadAttachment: vi.fn(),
  addAttachmentToMeeting: vi.fn(),
  getAttachmentsForMeeting: vi.fn(),
  getAttachmentUrl: vi.fn(),
  deleteAttachment: vi.fn(),
  getTranscriptSegments: vi.fn(),
  updateSpeakerContact: vi.fn(),
}));

/**
 * The batched per-meeting reads (CAR-229). They live in the domain modules
 * rather than the frozen @/lib/queries barrel, so they need their own mocks —
 * priming only `q` here would let the page reach the real db() seam.
 */
/** Rows the inline calendar_events read resolves with; set per test. */
const calendarEventRows = vi.hoisted(() => ({ current: [] as unknown[] }));

const batch = vi.hoisted(() => ({
  getActionItemsForMeetings: vi.fn(),
  getAttachmentsForMeetings: vi.fn(),
  getTranscriptSegmentsForMeetings: vi.fn(),
  getFirstEmailByContactId: vi.fn(),
}));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () =>
  mockToastModule(() => ({ success: toast.success, error: toast.error })),
);
vi.mock("@/hooks/use-gmail-connection", () => ({ useGmailConnection: () => ({ calendarConnected: true, loading: false }) }));
vi.mock("@/components/quick-capture-context", () => ({ useQuickCapture: () => ({ open: vi.fn(), openEdit: vi.fn() }) }));
vi.mock("@/lib/queries", () => q);
// The RSVP badge's calendar_events read is issued inline by the page.
vi.mock("@/lib/supabase/browser-client", () =>
  mockBrowserClientModule(() => ({
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        eq: () => Promise.resolve({ data: calendarEventRows.current, error: null }),
      };
      return builder;
    },
  })),
);
vi.mock("@/lib/data/action-items", () =>
  typedMock<typeof import("@/lib/data/action-items")>({
    createActionItem: vi.fn(),
    getActionItems: vi.fn(),
    getActionItemsForMeeting: vi.fn(),
    getActionItemsForMeetings: batch.getActionItemsForMeetings,
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
vi.mock("@/lib/data/attachments", () =>
  typedMock<typeof import("@/lib/data/attachments")>({
    uploadAttachment: vi.fn(),
    addAttachmentToContact: vi.fn(),
    addAttachmentToMeeting: vi.fn(),
    getAttachmentsForContact: vi.fn(),
    getAttachmentsForMeeting: vi.fn(),
    getAttachmentsForMeetings: batch.getAttachmentsForMeetings,
    getAttachmentUrl: vi.fn(),
    deleteAttachment: vi.fn(),
  }),
);
vi.mock("@/lib/data/meetings", () =>
  typedMock<typeof import("@/lib/data/meetings")>({
    getMeetings: vi.fn(),
    getMeetingsForContact: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    replaceContactsForMeeting: vi.fn(),
    addContactsToMeeting: vi.fn(),
    createTranscriptSegments: vi.fn(),
    getTranscriptSegments: vi.fn(),
    getTranscriptSegmentsForMeetings: batch.getTranscriptSegmentsForMeetings,
    getFirstEmailByContactId: batch.getFirstEmailByContactId,
    getContactsByEmail: vi.fn(),
    updateSpeakerContact: vi.fn(),
    deleteTranscriptSegments: vi.fn(),
  }),
);

import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { mockBrowserClientModule } from "./helpers/mock-supabase";
import { typedMock } from "./helpers/typed-mock";
import MeetingsPage from "@/app/meetings/page";

const meeting = {
  id: 1,
  meeting_date: "2026-07-10T12:00:00Z",
  meeting_type: "coffee",
  notes: null,
  transcript: null,
  transcript_parsed: false,
  calendar_event_id: null,
  meeting_contacts: [],
};
const completedAction = {
  id: 10,
  title: "Follow up with Jane",
  description: null,
  due_at: null,
  is_completed: true,
  completed_at: "2026-07-09T12:00:00Z",
  action_item_contacts: [],
  contacts: null,
};

function primeHappyQueries() {
  q.getMeetings.mockResolvedValue([meeting]);
  q.getContacts.mockResolvedValue([]);
  q.getAllInteractions.mockResolvedValue([]);
  primeMeetingActions([completedAction]);
  batch.getAttachmentsForMeetings.mockResolvedValue({});
  batch.getTranscriptSegmentsForMeetings.mockResolvedValue({});
  batch.getFirstEmailByContactId.mockResolvedValue(new Map());
}

/** Action items the batched read returns, keyed to the one fixture meeting. */
function primeMeetingActions(items: unknown[]) {
  batch.getActionItemsForMeetings.mockResolvedValue({ [meeting.id]: items });
}

beforeEach(() => {
  vi.clearAllMocks();
  calendarEventRows.current = [];
});
afterEach(() => cleanup());

describe("MeetingsPage — attendee RSVP badges (CAR-229)", () => {
  const linked = {
    ...meeting,
    id: 2,
    calendar_event_id: "gcal-1",
    meeting_contacts: [{ contact_id: 5, contacts: { id: 5, name: "Jane Doe", industry: null } }],
  };

  function primeLinkedMeeting() {
    q.getMeetings.mockResolvedValue([linked]);
    q.getContacts.mockResolvedValue([]);
    q.getAllInteractions.mockResolvedValue([]);
    batch.getActionItemsForMeetings.mockResolvedValue({});
    batch.getAttachmentsForMeetings.mockResolvedValue({});
    batch.getTranscriptSegmentsForMeetings.mockResolvedValue({});
    calendarEventRows.current = [{
      google_event_id: "gcal-1",
      attendees: [{ email: "jane@example.com", responseStatus: "accepted" }],
    }];
  }

  it("matches an attendee on the contact's first email, without the full contact list", async () => {
    primeLinkedMeeting();
    batch.getFirstEmailByContactId.mockResolvedValue(new Map([[5, "jane@example.com"]]));

    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("✓")).toBeTruthy());

    // Bounded by the attendees of calendar-linked meetings, not the whole list.
    expect(batch.getFirstEmailByContactId).toHaveBeenCalledWith(expect.any(String), [5]);
    expect(q.getContacts).not.toHaveBeenCalled();
  });

  it("renders the attendee with no badge when the address does not match", async () => {
    primeLinkedMeeting();
    batch.getFirstEmailByContactId.mockResolvedValue(new Map([[5, "other@example.com"]]));

    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());
    expect(screen.queryByText("✓")).toBeNull();
  });
});

describe("MeetingsPage — mutation failure contract (F21)", () => {
  it("toasts when restoring an action item fails, instead of swallowing it", async () => {
    primeHappyQueries();
    q.updateActionItem.mockRejectedValue(new Error("500"));
    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Follow up with Jane")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Restore"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("toasts when saving an inline action-item edit fails", async () => {
    primeHappyQueries();
    q.updateActionItem.mockRejectedValue(new Error("500"));
    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Follow up with Jane")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Edit"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The edit form stays open so nothing typed is lost.
    expect(screen.getByText("Save")).toBeTruthy();
  });
});

describe("MeetingsPage — action-item due dates (CAR-206)", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  function pending(due_at: string | null) {
    return { ...completedAction, id: 11, title: "Send the deck", is_completed: false, completed_at: null, due_at };
  }

  /** The due badge's element, so its overdue styling can be read. */
  function dueBadge(text: string) {
    const el = screen.getByText(text);
    expect(el.tagName).toBe("SPAN");
    return el;
  }

  it("renders the picked date and does not mark an item due today overdue", async () => {
    // This surface used to compare instants (`new Date(due_at) < new Date()`),
    // which called everything due TODAY overdue from local midnight onward —
    // including for a UTC user — while the action-items page did not.
    process.env.TZ = "America/Denver";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-10T18:00:00-06:00"));
    primeHappyQueries();
    primeMeetingActions([pending("2026-07-10T00:00:00+00:00")]);

    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Send the deck")).toBeTruthy());

    expect(dueBadge("Jul 10").className).not.toContain("text-destructive");
  });

  it("still marks a genuinely past item overdue", async () => {
    process.env.TZ = "America/Denver";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-10T09:00:00-06:00"));
    primeHappyQueries();
    primeMeetingActions([pending("2026-07-09T00:00:00+00:00")]);

    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Send the deck")).toBeTruthy());

    expect(dueBadge("Jul 9").className).toContain("text-destructive");
  });
});

describe("MeetingsPage — honest load-failure state (F21)", () => {
  it("renders a retryable error state when the meetings load fails", async () => {
    q.getMeetings.mockRejectedValue(new Error("boom"));
    q.getContacts.mockResolvedValue([]);
    q.getAllInteractions.mockResolvedValue([]);
    render(<MeetingsPage />);

    await waitFor(() => expect(screen.getByText("We could not load your activity")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    // Never the empty-list copy on a failed load.
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("shows an inline banner (not a full-screen error) when meetings fail but interactions loaded", async () => {
    q.getMeetings.mockRejectedValue(new Error("boom"));
    q.getContacts.mockResolvedValue([]);
    q.getAllInteractions.mockResolvedValue([
      {
        id: 5,
        interaction_type: "coffee",
        interaction_type_detail: null,
        interaction_date: "2026-07-08T12:00:00Z",
        summary: "Caught up over coffee",
        contacts: { name: "Jane Doe" },
      },
    ]);
    render(<MeetingsPage />);

    // The surviving interactions stay on screen with the failure flagged inline.
    await waitFor(() => expect(screen.getByText("Some of your activity could not be loaded.")).toBeTruthy());
    expect(screen.getByText("Caught up over coffee")).toBeTruthy();
    expect(screen.queryByText("We could not load your activity")).toBeNull();
  });
});

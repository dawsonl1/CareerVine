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

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1" };
  return { useAuth: () => ({ user }) };
});
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: toast.success, error: toast.error, info: vi.fn(), warning: vi.fn(), toast: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/hooks/use-gmail-connection", () => ({ useGmailConnection: () => ({ calendarConnected: true, loading: false }) }));
vi.mock("@/components/quick-capture-context", () => ({ useQuickCapture: () => ({ open: vi.fn(), openEdit: vi.fn() }) }));
vi.mock("@/lib/queries", () => q);

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
  q.getActionItemsForMeeting.mockResolvedValue([completedAction]);
  q.getAttachmentsForMeeting.mockResolvedValue([]);
  q.getTranscriptSegments.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("MeetingsPage — mutation failure contract (F21)", () => {
  it("toasts when restoring an action item fails, instead of swallowing it", async () => {
    primeHappyQueries();
    q.updateActionItem.mockRejectedValue(new Error("500"));
    render(<MeetingsPage />);
    await waitFor(() => expect(screen.getByText("Follow up with Jane")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Restore"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
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
});

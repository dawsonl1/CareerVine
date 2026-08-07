// @vitest-environment jsdom
/**
 * CAR-249 — the contact timeline's detail modal.
 *
 * What is worth pinning here is not "does it render text" but the three places
 * where a wrong answer is silent:
 *
 *  1. A failed section read renders its own banner, never the load-empty copy.
 *     "None from this conversation." over a failed action-item query is an
 *     affirmative claim about the user's data, and the user acts on it.
 *  2. Delete goes through the confirm, and a DECLINED confirm deletes nothing.
 *  3. The delete copy tells the truth about action items. `meeting_id` is
 *     ON DELETE SET NULL, so they survive the meeting unlinked; copy that says
 *     only "cannot be undone" leaves the user expecting the opposite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockToastModule } from "./helpers/mock-toast";
import { typedMock } from "./helpers/typed-mock";

const m = vi.hoisted(() => ({
  getMeetingById: vi.fn(),
  deleteMeeting: vi.fn(),
  getTranscriptSegments: vi.fn(),
  getActionItemsForMeeting: vi.fn(),
  deleteActionItem: vi.fn(),
  updateActionItem: vi.fn(),
  getAttachmentsForMeeting: vi.fn(),
  getAttachmentUrl: vi.fn(),
  openEdit: vi.fn(),
}));

vi.mock("@/lib/data/meetings", () =>
  typedMock<typeof import("@/lib/data/meetings")>({
    getMeetings: vi.fn(),
    getMeetingsForContact: vi.fn(),
    getMeetingById: m.getMeetingById,
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: m.deleteMeeting,
    replaceContactsForMeeting: vi.fn(),
    addContactsToMeeting: vi.fn(),
    createTranscriptSegments: vi.fn(),
    getTranscriptSegments: m.getTranscriptSegments,
    getTranscriptSegmentsForMeetings: vi.fn(),
    getFirstEmailByContactId: vi.fn(),
    getContactsByEmail: vi.fn(),
    updateSpeakerContact: vi.fn(),
    deleteTranscriptSegments: vi.fn(),
  }),
);
vi.mock("@/lib/data/action-items", () =>
  typedMock<typeof import("@/lib/data/action-items")>({
    createActionItem: vi.fn(),
    getActionItems: vi.fn(),
    getActionItemsForMeeting: m.getActionItemsForMeeting,
    getActionItemsForMeetings: vi.fn(),
    getActionItemsForContact: vi.fn(),
    getCompletedActionItems: vi.fn(),
    getCompletedActionItemsForContact: vi.fn(),
    replaceContactsForActionItem: vi.fn(),
    deleteActionItem: m.deleteActionItem,
    getOnboardingActionItemId: vi.fn(),
    updateActionItem: m.updateActionItem,
    snoozeActionItem: vi.fn(),
  }),
);
vi.mock("@/lib/data/attachments", () =>
  typedMock<typeof import("@/lib/data/attachments")>({
    uploadAttachment: vi.fn(),
    addAttachmentToContact: vi.fn(),
    addAttachmentToMeeting: vi.fn(),
    getAttachmentsForContact: vi.fn(),
    getAttachmentsForMeeting: m.getAttachmentsForMeeting,
    getAttachmentsForMeetings: vi.fn(),
    getAttachmentUrl: m.getAttachmentUrl,
    deleteAttachment: vi.fn(),
  }),
);
vi.mock("@/lib/data/interactions", () =>
  typedMock<typeof import("@/lib/data/interactions")>({
    getInteractions: vi.fn(),
    getAllInteractions: vi.fn(),
    createInteraction: vi.fn(),
    updateInteraction: vi.fn(),
    deleteInteraction: vi.fn(),
  }),
);
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: vi.fn(), gmailConnected: true }),
}));
vi.mock("@/components/quick-capture-context", () => ({
  useQuickCapture: () => ({ open: vi.fn(), openEdit: m.openEdit }),
}));

import { TimelineDetailModal } from "@/components/contacts/timeline-detail-modal";
import type { TimelineEntry } from "@/lib/types";

const MEETING_ROW = {
  id: 42,
  meeting_date: "2026-06-28T14:00:00Z",
  meeting_type: "coffee",
  meeting_type_detail: null,
  title: "LinkedIn chat",
  notes: "He gave me advice on product recruiting.",
  private_notes: "Follow up in two weeks",
  calendar_description: null,
  transcript: null,
  meeting_contacts: [{ contact_id: 7, contacts: { id: 7, name: "Spencer Hintze" } }],
};

const meetingEntry: TimelineEntry = {
  kind: "meeting",
  date: MEETING_ROW.meeting_date,
  // The row the TAB holds is the lightweight projection; only the id is read.
  data: { id: 42 } as Extract<TimelineEntry, { kind: "meeting" }>["data"],
};

function renderModal(entry: TimelineEntry, overrides: Record<string, unknown> = {}) {
  const props = {
    entry,
    contactName: "Spencer Hintze",
    canReadMailbox: false,
    gmailConnected: true,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onConfirmDelete: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(<TimelineDetailModal {...(props as React.ComponentProps<typeof TimelineDetailModal>)} />);
  return props;
}

beforeEach(() => {
  m.getMeetingById.mockResolvedValue(MEETING_ROW);
  m.getActionItemsForMeeting.mockResolvedValue([]);
  m.getAttachmentsForMeeting.mockResolvedValue([]);
  m.getTranscriptSegments.mockResolvedValue([]);
  m.deleteMeeting.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("timeline detail modal — meeting", () => {
  it("shows everything the row truncated away", async () => {
    renderModal(meetingEntry);

    await screen.findByText("He gave me advice on product recruiting.");
    expect(screen.getByText("Follow up in two weeks")).toBeTruthy();
    expect(screen.getByText("Spencer Hintze")).toBeTruthy();
    expect(screen.getByText("Coffee Chat")).toBeTruthy();
  });

  it("hands the FETCHED meeting to the conversation modal, not the row's projection", async () => {
    renderModal(meetingEntry);
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));

    expect(m.openEdit).toHaveBeenCalledTimes(1);
    // The tab's entry carries only `{id}`; edit mode reads meeting_contacts, so
    // passing the projection through would blank the attendee picker on save.
    expect(m.openEdit.mock.calls[0][0]).toMatchObject({ id: 42, title: "LinkedIn chat" });
    expect(m.openEdit.mock.calls[0][0].meeting_contacts).toHaveLength(1);
  });

  it("deletes only after the confirm resolves true", async () => {
    const props = renderModal(meetingEntry);
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    await waitFor(() => expect(m.deleteMeeting).toHaveBeenCalledWith(42));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("deletes NOTHING when the user declines", async () => {
    const props = renderModal(meetingEntry, { onConfirmDelete: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    await waitFor(() => expect(props.onConfirmDelete).toHaveBeenCalled());
    expect(m.deleteMeeting).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("warns that action items SURVIVE the delete, because meeting_id is SET NULL", async () => {
    m.getActionItemsForMeeting.mockResolvedValue([
      { id: 1, title: "Read Cracking the PM Case Interview", is_completed: false },
      { id: 2, title: "Send resume", is_completed: false },
    ]);
    const props = renderModal(meetingEntry);
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    await waitFor(() => expect(props.onConfirmDelete).toHaveBeenCalled());
    const { message } = props.onConfirmDelete.mock.calls[0][0];
    expect(message).toMatch(/2 action items/);
    expect(message).toMatch(/kept/i);
  });

  it("says nothing about action items when the meeting has none", async () => {
    const props = renderModal(meetingEntry);
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    await waitFor(() => expect(props.onConfirmDelete).toHaveBeenCalled());
    expect(props.onConfirmDelete.mock.calls[0][0].message).not.toMatch(/action item/i);
  });

  it("banners a failed action-item read instead of claiming there are none", async () => {
    m.getActionItemsForMeeting.mockRejectedValue(new Error("boom"));
    renderModal(meetingEntry);

    // The notes still render: allSettled means one failed read cannot blank the rest.
    await screen.findByText("He gave me advice on product recruiting.");
    expect(screen.getByText(/Couldn't load this conversation's action items/)).toBeTruthy();
    expect(screen.queryByText("None from this conversation.")).toBeNull();
  });

  it("banners a failed meeting read rather than rendering an empty detail", async () => {
    m.getMeetingById.mockRejectedValue(new Error("boom"));
    renderModal(meetingEntry);

    expect(await screen.findByText(/Couldn't load this conversation\./)).toBeTruthy();
  });

  it("distinguishes a DELETED meeting from a failed read", async () => {
    m.getMeetingById.mockResolvedValue(null);
    renderModal(meetingEntry);

    expect(await screen.findByText(/no longer exists/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load this conversation\./)).toBeNull();
  });
});

describe("timeline detail modal — completed action", () => {
  const entry: TimelineEntry = {
    kind: "completed_action",
    date: "2026-07-01T00:00:00Z",
    data: {
      id: 9,
      title: "Send resume",
      description: "Attach the PM-focused version",
      due_at: "2026-06-30T00:00:00Z",
      direction: "my_task",
      completed_at: "2026-07-01T00:00:00Z",
    },
  };

  it("shows the description the row never had room for", () => {
    renderModal(entry);
    expect(screen.getByText("Attach the PM-focused version")).toBeTruthy();
  });

  it("reopens through updateActionItem and re-reads the page", async () => {
    m.updateActionItem.mockResolvedValue(undefined);
    const props = renderModal(entry);
    fireEvent.click(screen.getByRole("button", { name: /reopen/i }));

    await waitFor(() =>
      expect(m.updateActionItem).toHaveBeenCalledWith(9, { is_completed: false, completed_at: null }),
    );
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("deletes only after the confirm resolves true", async () => {
    m.deleteActionItem.mockResolvedValue(undefined);
    renderModal(entry, { onConfirmDelete: vi.fn().mockResolvedValue(false) });
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(m.deleteActionItem).not.toHaveBeenCalled());
  });
});

describe("timeline detail modal — closed", () => {
  it("reads nothing while no row is selected", () => {
    renderModal(null as unknown as TimelineEntry);
    expect(m.getMeetingById).not.toHaveBeenCalled();
  });
});

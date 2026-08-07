// @vitest-environment jsdom
/**
 * CAR-260 — the contact timeline groups emails by conversation.
 *
 * The behavior worth pinning is the part that is silent when wrong:
 *
 *  1. A conversation is ONE row and counts as one. The old flattening made a
 *     six-message back-and-forth look like six separate events, which is what
 *     the header count reported to the user.
 *  2. Expanding a stack still hands the detail modal a SINGLE message. If a
 *     thread ever reached `onEntryClick`, the modal's switch has no branch for
 *     it and the user gets an empty dialog.
 *  3. The mirror-interaction fold keys on the email being PRESENT, not on the
 *     column being set. Getting that backwards deletes the only surviving
 *     record of a send from the timeline whenever the email read fails, which
 *     is exactly the confident-lie failure CAR-205 exists to stop.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ContactTimelineTab } from "@/components/contacts/contact-timeline-tab";
import type { EmailMessage, InteractionRow, ContactMeeting } from "@/lib/types";

afterEach(cleanup);

function email(over: Partial<EmailMessage> & { id: number; gmail_message_id: string }): EmailMessage {
  return {
    ai_assisted: false,
    body_html: null,
    created_at: null,
    date: "2026-08-04T10:00:00Z",
    direction: "outbound",
    from_address: "me@example.com",
    is_excluded: false,
    is_hidden: false,
    is_read: true,
    is_simulated: false,
    is_trashed: false,
    label_ids: null,
    matched_contact_id: 1,
    snippet: "snippet",
    subject: "BYU senior, curious about your path at R1",
    thread_id: "t1",
    to_addresses: ["them@example.com"],
    user_id: "u1",
    ...over,
  } as EmailMessage;
}

function interaction(over: Partial<InteractionRow> & { id: number }): InteractionRow {
  return {
    contact_id: 1,
    email_message_id: null,
    interaction_date: "2026-08-04T10:00:00Z",
    interaction_type: "email",
    interaction_type_detail: null,
    is_excluded: false,
    summary: "Sent: BYU senior, curious about your path at R1",
    ...over,
  } as InteractionRow;
}

/** Three messages on one thread, plus a standalone automated notice. */
const THREAD_OF_THREE = [
  email({ id: 1, gmail_message_id: "m1", date: "2026-08-04T10:00:00Z" }),
  email({ id: 2, gmail_message_id: "m2", date: "2026-08-04T11:00:00Z", direction: "inbound" }),
  email({ id: 3, gmail_message_id: "m3", date: "2026-08-04T12:00:00Z" }),
];

function renderTab(props: Partial<React.ComponentProps<typeof ContactTimelineTab>> = {}) {
  const onEntryClick = vi.fn();
  const onToggleThread = vi.fn();
  const onToggleShowRemoved = vi.fn();
  const view = render(
    <ContactTimelineTab
      meetings={[]}
      interactions={[]}
      emails={THREAD_OF_THREE}
      completedActions={[]}
      loading={false}
      onEntryClick={onEntryClick}
      expandedThreads={new Set()}
      onToggleThread={onToggleThread}
      showRemoved={false}
      onToggleShowRemoved={onToggleShowRemoved}
      {...props}
    />
  );
  return { onEntryClick, onToggleThread, onToggleShowRemoved, ...view };
}

describe("contact timeline thread stacking", () => {
  it("renders a multi-message conversation as one row and counts it once", () => {
    renderTab();
    expect(screen.getByText("Timeline (1)")).toBeTruthy();
    expect(screen.getByText("3 messages")).toBeTruthy();
  });

  it("keeps a lone message as a plain row with no expand control", () => {
    renderTab({ emails: [email({ id: 9, gmail_message_id: "solo", thread_id: "t9" })] });
    expect(screen.queryByText("1 messages")).toBeNull();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("places the stack at the thread's LATEST message, not its first", () => {
    // The meeting sits between the thread's first (10:00) and last (12:00)
    // message. A stack anchored to the oldest message would sort below it.
    const meeting: ContactMeeting = {
      id: 5,
      meeting_date: "2026-08-04T11:30:00Z",
      meeting_type: "coffee",
      meeting_type_detail: null,
      title: "Coffee chat",
      notes: null,
      private_notes: null,
      calendar_description: null,
      transcript: null,
      is_excluded: false,
    };
    renderTab({ meetings: [meeting] });
    // The header's Show removed control is a button too, and carries no
    // aria-label; the rows are the labelled ones.
    const rows = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-label"));
    expect(rows[0].getAttribute("aria-label")).toContain("3 messages");
    expect(rows[1].getAttribute("aria-label")).toContain("Coffee chat");
  });

  it("expanding hands the modal a single message, never the thread", () => {
    const { onEntryClick } = renderTab({ expandedThreads: new Set(["t1"]) });
    // All three share a subject and a date, so they are only distinguishable by
    // position. Oldest first, matching how the Emails tab reads a conversation.
    const messages = screen.getAllByLabelText(/^BYU senior.*Open details/);
    expect(messages).toHaveLength(3);
    fireEvent.click(messages[0]);
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    const entry = onEntryClick.mock.calls[0][0];
    expect(entry.kind).toBe("email");
    expect(entry.data.gmail_message_id).toBe("m1");
  });

  it("toggles through the page-owned callback rather than local state", () => {
    const { onToggleThread } = renderTab();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggleThread).toHaveBeenCalledWith("t1");
  });
});

describe("mirror-interaction folding", () => {
  it("drops the interaction a loaded sent email already represents", () => {
    renderTab({ interactions: [interaction({ id: 100, email_message_id: 1 })] });
    // One row: the thread. The mirror is folded away rather than doubling it.
    expect(screen.getByText("Timeline (1)")).toBeTruthy();
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("KEEPS the mirror when the email read failed, rather than losing the send", () => {
    renderTab({
      emails: [],
      emailsLoadFailed: true,
      onReloadEmails: vi.fn(),
      interactions: [interaction({ id: 100, email_message_id: 1 })],
    });
    expect(screen.getByText("Timeline (1)")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
  });

  it("keeps a hand-logged interaction, which mirrors nothing", () => {
    renderTab({
      interactions: [interaction({ id: 101, email_message_id: null, interaction_type: "coffee" })],
    });
    expect(screen.getByText("Timeline (2)")).toBeTruthy();
  });
});

describe("struck entries", () => {
  const struckEmail = email({ id: 7, gmail_message_id: "auto", thread_id: "t7", is_excluded: true,
    subject: "Accepted: Dawson<>Bryant: Call about R1 Product", direction: "inbound" });

  it("hides a struck entry by default", () => {
    renderTab({ emails: [...THREAD_OF_THREE, struckEmail] });
    expect(screen.getByText("Timeline (1)")).toBeTruthy();
    expect(screen.queryByText(/^Accepted:/)).toBeNull();
  });

  it("reveals it, marked, when Show removed is on", () => {
    renderTab({ emails: [...THREAD_OF_THREE, struckEmail], showRemoved: true });
    expect(screen.getByText("Timeline (2)")).toBeTruthy();
    expect(screen.getByText(/^Accepted:/)).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
  });

  it("keeps a struck message out of its thread's count", () => {
    // Same thread as the other three, so a fold that ignored is_excluded would
    // report four messages rather than three.
    renderTab({ emails: [...THREAD_OF_THREE, email({ id: 8, gmail_message_id: "m4", is_excluded: true })] });
    expect(screen.getByText("3 messages")).toBeTruthy();
  });

  it("does not let a struck mirror interaction reappear as a standalone row", () => {
    // The email is struck and therefore absent from the loaded list, so the
    // presence-keyed fold would keep its mirror. The mirror is struck too, and
    // that is what has to remove it.
    renderTab({
      emails: [],
      interactions: [interaction({ id: 200, email_message_id: 999, is_excluded: true })],
    });
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("offers the toggle even when everything is struck, or there is no way back", () => {
    renderTab({ emails: [struckEmail] });
    expect(screen.getByText("Show removed")).toBeTruthy();
  });
});

// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-102: the free Outreach portal renders sent / scheduled / follow-up views
 * from the DB-only /api/gmail/inbox payload. No live mailbox anywhere.
 */

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/follow-up-modal", () => ({
  FollowUpModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Edit follow-ups">Edit follow-ups modal</div> : null,
}));
// Stable user reference (created once in the factory closure) — matches the real
// context-backed useAuth, so the load effect doesn't re-run on every render.
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1" };
  return { useAuth: () => ({ user }) };
});

const openCompose = vi.fn();
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ gmailConnected: true, gmailLoading: false, openCompose }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const payload = {
  success: true,
  emails: [
    {
      gmail_message_id: "m1",
      thread_id: "t1",
      subject: "Coffee chat?",
      direction: "outbound",
      to_addresses: ["jane@corp.com"],
      date: "2026-07-10T12:00:00Z",
      matched_contact_id: 5,
      snippet: "Hi Jane, coffee next week?",
      body_html: "<p>Hi Jane, coffee next week?</p>",
    },
  ],
  scheduledEmails: [
    {
      id: 1,
      subject: "Following up next week",
      recipient_email: "bob@x.com",
      contact_name: "Bob",
      matched_contact_id: null,
      scheduled_send_at: "2026-07-20T09:00:00Z",
    },
  ],
  followUps: [
    {
      id: 1,
      original_subject: "Intro to the team",
      recipient_email: "amy@y.com",
      contact_id: null,
      contact_name: "Amy",
      original_sent_at: "2026-07-01T12:00:00Z",
      original_gmail_message_id: "orig-1",
      thread_id: "th-1",
      email_follow_up_messages: [
        {
          id: 1,
          status: "awaiting_review",
          subject: "Quick nudge",
          sequence_number: 1,
          send_after_days: 7,
          scheduled_send_at: "2026-07-08T09:00:00Z",
          expires_at: "2026-07-22T09:00:00Z",
        },
        {
          id: 2,
          status: "pending",
          subject: "Second check-in",
          sequence_number: 2,
          send_after_days: 14,
          scheduled_send_at: "2026-07-15T09:00:00Z",
          expires_at: null,
        },
      ],
    },
  ],
  contactMap: { 5: "Jane Doe" },
  gmailAddress: "me@gmail.com",
};

import { OutreachShell } from "@/components/email/outreach/outreach-shell";

describe("OutreachShell — free tier portal", () => {
  beforeEach(() => {
    openCompose.mockClear();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
  });
  afterEach(() => cleanup());

  it("renders the sent thread by default, with the contact name resolved", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    expect(screen.getByText(/To Jane Doe/)).toBeTruthy();
    // tab counts
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Scheduled")).toBeTruthy();
    expect(screen.getByText("Follow-ups")).toBeTruthy();
  });

  it("switches to the Scheduled and Follow-ups views", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());

    fireEvent.click(screen.getByText("Scheduled"));
    expect(screen.getByText("Following up next week")).toBeTruthy();

    fireEvent.click(screen.getByText("Follow-ups"));
    expect(screen.getByText("Intro to the team")).toBeTruthy();
  });

  it("surfaces confirm-to-send for an awaiting_review step and posts to the confirm route", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Follow-ups"));

    expect(screen.getByText("Send now")).toBeTruthy();
    expect(screen.getByText("They replied")).toBeTruthy();

    fireEvent.click(screen.getByText("Send now"));
    await waitFor(() =>
      expect(
        (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (c) => c[0] === "/api/gmail/follow-ups/confirm",
        ),
      ).toBe(true),
    );
  });

  it("shows pending steps with subject and opens Edit follow-ups modal (CAR-125)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Follow-ups"));

    expect(screen.getByText(/Step 1: Quick nudge/)).toBeTruthy();
    expect(screen.getByText(/Step 2: Second check-in/)).toBeTruthy();
    expect(screen.getByText("Needs confirm")).toBeTruthy();
    expect(screen.getByText(/Scheduled Jul 15/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit follow-ups/i }));
    expect(screen.getByRole("dialog", { name: /edit follow-ups/i })).toBeTruthy();
  });

  it("expands a sent email to reveal the persisted body (CAR-115), collapsed by default", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());

    // Body is hidden until the row is expanded.
    expect(screen.queryByText("Hi Jane, coffee next week?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /expand to read/i }));
    expect(screen.getByText("Hi Jane, coffee next week?")).toBeTruthy();
  });

  it("falls back to the stored snippet when a sent email has no persisted body", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...payload,
        emails: [
          {
            gmail_message_id: "m2",
            thread_id: "t2",
            subject: "Older outreach",
            direction: "outbound",
            to_addresses: ["sam@corp.com"],
            date: "2026-06-01T12:00:00Z",
            matched_contact_id: null,
            snippet: "Only a snippet survived for this one",
            body_html: null,
          },
        ],
      }),
    })) as unknown as typeof fetch;

    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Older outreach")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /expand to read/i }));
    expect(screen.getByText("Only a snippet survived for this one")).toBeTruthy();
  });

  it("opens the compose modal from the Compose button (send is free)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Compose"));
    expect(openCompose).toHaveBeenCalled();
  });
});

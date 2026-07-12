// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-102: the free Outreach portal renders sent / scheduled / follow-up views
 * from the DB-only /api/gmail/inbox payload. No live mailbox anywhere.
 */

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
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
      email_follow_up_messages: [
        { id: 1, status: "awaiting_review", subject: "Quick nudge", sequence_number: 1, send_after_days: 7, scheduled_send_at: "2026-07-25T09:00:00Z" },
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

  it("opens the compose modal from the Compose button (send is free)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Compose"));
    expect(openCompose).toHaveBeenCalled();
  });
});

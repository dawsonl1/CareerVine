// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-102: the free Outreach portal renders sent / scheduled / follow-up / drafts
 * views. Inbox + follow-ups come from the DB-only /api/gmail/inbox payload;
 * drafts load from /api/gmail/drafts. No live mailbox anywhere.
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

// matched_contact_id and body_html are nullable in the real inbox payload (an
// email may match no contact and may have no persisted HTML body). The base
// fixture only carries non-null values, so annotate the element type explicitly
// or later "no persisted body" cases (null body_html) won't typecheck.
type FixtureEmail = {
  gmail_message_id: string;
  thread_id: string;
  subject: string;
  direction: string;
  to_addresses: string[];
  date: string;
  matched_contact_id: number | null;
  snippet: string;
  body_html: string | null;
};

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
  ] as FixtureEmail[],
  scheduledEmails: [
    {
      id: 1,
      subject: "Following up next week",
      recipient_email: "bob@x.com",
      contact_name: "Bob",
      matched_contact_id: null,
      scheduled_send_at: "2026-07-20T09:00:00Z",
      body_html: "<p>Bob, circling back on the coffee chat we discussed.</p>",
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
          body_html: "<p>Amy, just bumping this in case it got buried.</p>",
          sequence_number: 1,
          send_after_days: 7,
          scheduled_send_at: "2026-07-08T09:00:00Z",
          expires_at: "2026-07-22T09:00:00Z",
        },
        {
          id: 2,
          status: "pending",
          subject: "Second check-in",
          body_html: "<p>Amy, one last note before I close the loop.</p>",
          sequence_number: 2,
          send_after_days: 14,
          scheduled_send_at: "2026-07-15T09:00:00Z",
          expires_at: null,
        },
      ],
    },
  ],
  contactMap: { 5: "Jane Doe" },
  contactDetails: {
    5: {
      id: 5,
      name: "Jane Doe",
      title: "Product Manager",
      company_id: 9,
      company_name: "Acme",
      location_label: "SF, CA",
    },
    7: {
      id: 7,
      name: "Leo",
      title: "Recruiter",
      company_id: 11,
      company_name: "Samsara",
      location_label: "Remote",
    },
  },
  gmailAddress: "me@gmail.com",
};

const draftsPayload = {
  drafts: [
    {
      id: 42,
      user_id: "u-1",
      recipient_email: "leo@corp.com",
      contact_name: "Leo",
      matched_contact_id: 7,
      cc: null,
      bcc: null,
      subject: "Half-finished intro",
      body_html: "<p>Hey Leo, still drafting this…</p>",
      thread_id: null,
      in_reply_to: null,
      references_header: null,
      updated_at: "2026-07-14T12:00:00Z",
      created_at: "2026-07-14T11:00:00Z",
    },
  ],
  contactDetails: {
    7: {
      id: 7,
      name: "Leo",
      title: "Recruiter",
      company_id: 11,
      company_name: "Samsara",
      location_label: "Remote",
    },
  },
};

function mockFetch(inbox = payload, drafts = draftsPayload) {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.includes("/api/gmail/drafts/") && init?.method === "DELETE") {
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (path.includes("/api/gmail/drafts")) {
      return { ok: true, json: async () => drafts };
    }
    return { ok: true, json: async () => inbox };
  }) as unknown as typeof fetch;
}

import { OutreachShell } from "@/components/email/outreach/outreach-shell";

describe("OutreachShell — free tier portal", () => {
  beforeEach(() => {
    openCompose.mockClear();
    mockFetch();
  });
  afterEach(() => cleanup());

  it("renders the sent thread by default, with the contact name resolved", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Jane Doe" }).getAttribute("href")).toBe("/contacts/5");
    expect(screen.getByText("Product Manager")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Acme" }).getAttribute("href")).toBe("/companies/9");
    expect(screen.getByText("SF, CA")).toBeTruthy();
    // tab counts
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Drafts")).toBeTruthy();
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
    mockFetch({
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
    });

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

  it("lists drafts, expands body, edits into compose with draftId, and cancels (CAR-127)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());

    fireEvent.click(screen.getByText("Drafts"));
    await waitFor(() => expect(screen.getByText("Half-finished intro")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Leo" }).getAttribute("href")).toBe("/contacts/7");
    expect(screen.getByText("Recruiter")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Samsara" }).getAttribute("href")).toBe("/companies/11");
    expect(screen.getByText("Remote")).toBeTruthy();

    // Body hidden until expand
    expect(screen.queryByText(/still drafting this/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand to read draft/i }));
    expect(screen.getByText(/still drafting this/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit draft/i }));
    expect(openCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "leo@corp.com",
        name: "Leo",
        subject: "Half-finished intro",
        draftId: 42,
        contactId: 7,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel draft/i }));
    await waitFor(() =>
      expect(
        (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (c) => typeof c[0] === "string" && String(c[0]).includes("/api/gmail/drafts/42"),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("Half-finished intro")).toBeNull());
  });

  it("expands a scheduled email to show its full body (CAR-128)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Scheduled"));

    expect(screen.queryByText(/circling back on the coffee chat/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand to read scheduled email/i }));
    expect(screen.getByText(/circling back on the coffee chat/)).toBeTruthy();
  });

  it("expands a follow-up step to show its full body (CAR-128)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByText("Follow-ups"));

    expect(screen.queryByText(/bumping this in case it got buried/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand to read step 1/i }));
    expect(screen.getByText(/bumping this in case it got buried/)).toBeTruthy();

    // Expanding another step swaps focus; step 2 body appears.
    fireEvent.click(screen.getByRole("button", { name: /expand to read step 2/i }));
    expect(screen.getByText(/one last note before I close the loop/)).toBeTruthy();
  });

  it("renders expanded sent bodies without a nested max-height clip (CAR-128)", async () => {
    render(<OutreachShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /expand to read/i }));

    const body = screen.getByText("Hi Jane, coffee next week?");
    // Walk up to the prose container and assert we did not reintroduce the clip.
    let el: HTMLElement | null = body;
    while (el && !el.className.includes("prose")) el = el.parentElement;
    expect(el).toBeTruthy();
    expect(String(el?.className || "")).not.toMatch(/max-h-/);
    expect(String(el?.className || "")).not.toMatch(/overflow-y-auto/);
  });
});

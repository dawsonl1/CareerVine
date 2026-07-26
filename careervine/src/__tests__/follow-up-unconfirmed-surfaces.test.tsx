// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import { mockToastModule } from "./helpers/mock-toast";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";

/**
 * The `failed` follow-up step has to be VISIBLE, and this had no UI coverage at
 * all when CAR-207 shipped it.
 *
 * The gap that made that dangerous: the sweeper writes `failed` and then, in the
 * same tick, completes the parent sequence — because `failed` is terminal and so
 * is absent from the set that keeps a sequence open. Every surface here filtered
 * on `fu.status === "active"`, so the one state whose entire purpose is to warn
 * the user rendered for exactly zero seconds on a one-step sequence, and
 * disappeared the moment the last sibling sent on a multi-step one.
 *
 * These pin the two halves that matter: the record survives completion, and it
 * never offers a way to send. Sending again is the defect CAR-207 exists to
 * close, so "no Send now" is as load-bearing as "visible".
 */

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: vi.fn() }),
}));

import { ContactEmailsTab } from "@/components/contacts/contact-emails-tab";

const FOLLOW_UPS_ROUTE = "GET /api/gmail/follow-ups";
const THREAD_ID = "t-1";

const message = (id: number, status: string) => ({
  id,
  sequence_number: id,
  send_after_days: id * 3,
  status,
  subject: `Step ${id}`,
  body_html: "<p>hi</p>",
  scheduled_send_at: "2026-07-10T12:00:00.000Z",
  expires_at: null,
});

function sequence(status: string, messages: ReturnType<typeof message>[]) {
  return {
    id: 7,
    status,
    thread_id: THREAD_ID,
    recipient_email: "ada@example.com",
    contact_name: "Ada Lovelace",
    original_subject: "Intro",
    original_sent_at: "2026-07-01T12:00:00.000Z",
    original_gmail_message_id: "gmid-1",
    email_follow_up_messages: messages,
  };
}

/** The chip's label is assembled from sibling text nodes, so match on the
 *  element's whole normalized text rather than a single node. */
const hasText = (needle: string) => (_content: string, el: Element | null) =>
  el?.textContent?.includes(needle) === true && el.children.length === 0;

async function renderTab(sequences: unknown[]) {
  const http = installFakeFetch({
    [FOLLOW_UPS_ROUTE]: { body: { followUps: sequences } },
    // Expanding a thread re-reads that thread's follow-ups. Routed so the
    // request is answered rather than landing in `unmatched`, where a handler
    // that swallows rejections would hide it.
    [`${FOLLOW_UPS_ROUTE}?threadId=${THREAD_ID}`]: { body: { followUps: sequences } },
  });
  await act(async () => {
    render(
      <ContactEmailsTab
        contactId={7}
        contactName="Ada Lovelace"
        contactEmails={["ada@example.com"]}
        emails={[
          {
            id: 1,
            thread_id: THREAD_ID,
            gmail_message_id: "gmid-1",
            subject: "Intro",
            snippet: "hello",
            date: "2026-07-01T12:00:00.000Z",
            direction: "outbound",
            from_address: "me@example.com",
            to_addresses: ["ada@example.com"],
            is_read: true,
          } as never,
        ]}
        scheduledEmails={[]}
        gmailConnected
        canReadMailbox
        loadingEmails={false}
        emailsLoadFailed={false}
        scheduledLoadFailed={false}
        onScheduledEmailCancel={vi.fn()}
        onReloadEmails={vi.fn()}
      />,
    );
  });
  // The follow-up block only renders inside an EXPANDED thread. Without this,
  // every negative assertion below passes on an empty document rather than on
  // the absence it claims to check, and the positives are the only thing that
  // would ever notice.
  await act(async () => {
    fireEvent.click(screen.getByText("Intro"));
  });
  return http;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.clearAllMocks());

describe("ContactEmailsTab — an unconfirmed follow-up step (CAR-207 review)", () => {
  it("keeps showing the step after the sweep completes the sequence", async () => {
    // The regression: `completed` used to be filtered out entirely here, so the
    // chip and the warning were unreachable for exactly the sequences that had
    // one, and the user was instead shown a green "Follow-ups completed".
    const http = await renderTab([sequence("completed", [message(1, "sent"), message(2, "failed")])]);

    expect(screen.getByText(hasText("(send unconfirmed)"))).toBeTruthy();
    expect(
      screen.getByText(/A step could not be confirmed\. Check your Gmail Sent folder/),
    ).toBeTruthy();
    expect(http.unmatched).toEqual([]);
  });

  it("does not claim the sequence completed when a step is unconfirmed", async () => {
    await renderTab([sequence("completed", [message(1, "sent"), message(2, "failed")])]);

    expect(screen.queryByText("Follow-ups completed")).toBeNull();
  });

  it("still says completed for a sequence that genuinely finished", async () => {
    // Guards the assertion above from passing because the label vanished for
    // everyone rather than for the unconfirmed case specifically.
    await renderTab([sequence("completed", [message(1, "sent"), message(2, "sent")])]);

    expect(screen.getByText("Follow-ups completed")).toBeTruthy();
    expect(screen.queryByText(hasText("(send unconfirmed)"))).toBeNull();
  });

  it("never offers a way to send an unconfirmed step", async () => {
    // The whole point of the ticket. `failed` is excluded from the actionable
    // vocabulary, so neither confirm control may render for it.
    await renderTab([sequence("completed", [message(1, "sent"), message(2, "failed")])]);

    expect(screen.queryByText("Send now")).toBeNull();
    expect(screen.queryByText("They replied")).toBeNull();
  });

  it("suppresses the scheduled count rather than reading '0 follow-ups scheduled'", async () => {
    await renderTab([sequence("completed", [message(1, "sent"), message(2, "failed")])]);

    expect(screen.queryByText(/follow-ups? scheduled/)).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * CAR-249 — the shared email-body loader, extracted from contact-emails-tab so
 * the timeline detail modal renders the same message from one implementation.
 *
 * The behavior worth pinning is the CAPABILITY GATE. `canReadMailbox` is
 * CAR-102's premium live-mailbox scope; `/api/gmail/emails/{id}` 403s without
 * it. A free user must be served the row's cached snippet and the gated route
 * must never be called — a duplicate of this logic getting that backwards is
 * precisely why it now lives in one place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import { useEmailBody } from "@/hooks/use-email-body";
import type { EmailMessage } from "@/lib/types";

const message = (over: Partial<EmailMessage> = {}): EmailMessage =>
  ({
    gmail_message_id: "msg-1",
    thread_id: "thread-1",
    subject: "Coffee?",
    snippet: "Would love to chat about PM roles",
    from_address: "spencer@lucid.co",
    to_addresses: ["me@example.com"],
    direction: "inbound",
    date: "2026-06-28T14:00:00Z",
    is_read: true,
    ...over,
  }) as EmailMessage;

const FULL = {
  subject: "Coffee?",
  from: "spencer@lucid.co",
  to: "me@example.com",
  date: "2026-06-28T14:00:00Z",
  bodyHtml: "<p>Full body</p>",
  bodyText: null,
  messageId: "<abc@mail>",
  gmailMessageId: "msg-1",
  threadId: "thread-1",
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("useEmailBody", () => {
  it("serves the cached snippet on the free tier and never calls the gated route", async () => {
    const http = installFakeFetch({});
    const { result } = renderHook(() => useEmailBody({ canReadMailbox: false }));

    await act(async () => {
      await result.current.load(message());
    });

    expect(result.current.content?.bodyText).toBe("Would love to chat about PM roles");
    expect(result.current.content?.bodyHtml).toBeNull();
    // The whole point: no request was issued at all.
    expect(http.unmatched).toEqual([]);
  });

  it("fetches the real body when the mailbox scope is held", async () => {
    const http = installFakeFetch({
      "GET /api/gmail/emails/msg-1": { body: { success: true, message: FULL } },
    });
    const { result } = renderHook(() => useEmailBody({ canReadMailbox: true }));

    await act(async () => {
      await result.current.load(message());
    });

    await waitFor(() => expect(result.current.content?.bodyHtml).toBe("<p>Full body</p>"));
    expect(http.countOf("GET /api/gmail/emails/msg-1")).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("reports a failed fetch rather than leaving an empty body on screen", async () => {
    installFakeFetch({
      "GET /api/gmail/emails/msg-1": { status: 500, body: { error: "boom" } },
    });
    const { result } = renderHook(() => useEmailBody({ canReadMailbox: true }));

    await act(async () => {
      await result.current.load(message());
    });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.content).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not mark read unless the caller asked, and never on the free tier", async () => {
    const http = installFakeFetch({
      "GET /api/gmail/emails/msg-1": { body: { success: true, message: FULL } },
    });
    const { result } = renderHook(() => useEmailBody({ canReadMailbox: true }));

    await act(async () => {
      await result.current.load(message({ is_read: false }));
    });

    // markRead defaults false: the timeline detail renders a body the user
    // reached from a history row, and the Emails tab owns the read mirror.
    expect(http.countOf("POST /api/gmail/emails/msg-1/read")).toBe(0);
    expect(http.unmatched).toEqual([]);
  });

  it("marks read, once, when the caller opts in on an unread message", async () => {
    const http = installFakeFetch({
      "GET /api/gmail/emails/msg-1": { body: { success: true, message: FULL } },
      "POST /api/gmail/emails/msg-1/read": { body: { success: true } },
    });
    const onMarkedRead = vi.fn();
    const { result } = renderHook(() =>
      useEmailBody({ canReadMailbox: true, markRead: true, onMarkedRead }),
    );

    await act(async () => {
      await result.current.load(message({ is_read: false }));
    });

    expect(http.countOf("POST /api/gmail/emails/msg-1/read")).toBe(1);
    expect(onMarkedRead).toHaveBeenCalled();

    // An already-read message is not re-marked.
    await act(async () => {
      await result.current.load(message({ is_read: true }));
    });
    expect(http.countOf("POST /api/gmail/emails/msg-1/read")).toBe(1);
  });

  it("drops a superseded body so a slow fetch cannot overwrite the newer one", async () => {
    let releaseSlow: (() => void) | null = null;
    const http = installFakeFetch({
      "GET /api/gmail/emails/slow": {
        body: { success: true, message: { ...FULL, bodyHtml: "<p>STALE</p>" } },
        // Held open until the newer request has already settled.
        delay: new Promise<void>((resolve) => {
          releaseSlow = resolve;
        }),
      },
      "GET /api/gmail/emails/fast": {
        body: { success: true, message: { ...FULL, bodyHtml: "<p>FRESH</p>" } },
      },
    });
    const { result } = renderHook(() => useEmailBody({ canReadMailbox: true }));

    let slow: Promise<boolean>;
    act(() => {
      slow = result.current.load(message({ gmail_message_id: "slow" }));
    });
    await act(async () => {
      await result.current.load(message({ gmail_message_id: "fast" }));
    });
    await waitFor(() => expect(result.current.content?.bodyHtml).toBe("<p>FRESH</p>"));

    await act(async () => {
      releaseSlow?.();
      await slow;
    });

    // The stale response landed last and must have been discarded.
    expect(result.current.content?.bodyHtml).toBe("<p>FRESH</p>");
    expect(http.unmatched).toEqual([]);
  });
});

// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import { mockToastModule, toastMock } from "./helpers/mock-toast";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";

/**
 * CAR-183: cancelling a follow-up sequence used to `await fetch(DELETE)` without
 * checking the response, then mark the row `cancelled_user` regardless. The
 * route answers 404 on an ownership miss and 500 when the cascade throws, and
 * neither rejects the promise — so the UI reported "Cancelled" while the
 * sequence stayed live and the next cron tick emailed the contact.
 *
 * These assert the gate, not the helper: the row keeps its real status on every
 * failure shape, and only a 2xx applies the optimistic update.
 */

// Shared typed factories (CAR-187). mockAuthProviderModule's default user is
// built once at module load, which this component specifically needs: its load
// effect lists `user` in its dependency array, so a mock returning a fresh
// object per render would re-fire the effect forever.
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());

import { ContactFollowUpStatus } from "@/components/contacts/contact-follow-up-status";

const CONTACT_ID = 1;
const SEQUENCE_ID = 7;
const LIST_ROUTE = `GET /api/email-follow-ups?contactId=${CONTACT_ID}`;
const CANCEL_ROUTE = `DELETE /api/email-follow-ups/${SEQUENCE_ID}`;
const TOAST_COPY = "Couldn't cancel that follow-up sequence. Please try again.";

/** One active sequence, one of its two messages already sent. */
function activeSequence() {
  return {
    id: SEQUENCE_ID,
    status: "active",
    original_subject: "Coffee next week?",
    original_sent_at: "2026-07-01T12:00:00.000Z",
    messages: [
      {
        id: 11,
        sequence_number: 1,
        status: "sent",
        scheduled_send_at: "2026-07-03T12:00:00.000Z",
        sent_at: "2026-07-03T12:00:00.000Z",
      },
      {
        id: 12,
        sequence_number: 2,
        status: "pending",
        scheduled_send_at: "2026-07-10T12:00:00.000Z",
        sent_at: null,
      },
    ],
  };
}

/**
 * Render with the list already loaded and click Cancel. Returns the fetch
 * handle so a test can assert exactly which requests were issued.
 */
async function renderAndCancel(cancelRoute: Parameters<typeof installFakeFetch>[0][string]) {
  const http = installFakeFetch({
    [LIST_ROUTE]: { body: { sequences: [activeSequence()] } },
    [CANCEL_ROUTE]: cancelRoute,
  });

  await act(async () => {
    render(<ContactFollowUpStatus contactId={CONTACT_ID} />);
  });

  // Guard: the component renders null until the list resolves, so a failure to
  // find this would otherwise read as "the cancel worked".
  expect(screen.getByText("1 of 2 sent")).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByText("Cancel"));
  });

  return http;
}

describe("ContactFollowUpStatus — cancel (CAR-183)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the sequence active and toasts when the route answers 404", async () => {
    const http = await renderAndCancel({
      status: 404,
      body: { error: "Follow-up sequence not found" },
    });

    // Still shown as active, NOT as cancelled.
    expect(screen.getByText("1 of 2 sent")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(TOAST_COPY);
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
  });

  it("keeps the sequence active and toasts when the route answers 500", async () => {
    const http = await renderAndCancel({
      status: 500,
      body: { error: "Something went wrong" },
    });

    expect(screen.getByText("1 of 2 sent")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(TOAST_COPY);
    // Without this the toast assertion would also be satisfied by the harness's
    // own "no route" throw, i.e. by never reaching the 500 at all.
    expect(http.unmatched).toEqual([]);
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
  });

  it("keeps the sequence active and toasts when the request never lands", async () => {
    // The only failure the original bare try/catch could observe. It must stay
    // covered now that the check moved into apiSend.
    const http = await renderAndCancel({ reject: new TypeError("Failed to fetch") });

    expect(screen.getByText("1 of 2 sent")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(TOAST_COPY);
    expect(http.unmatched).toEqual([]);
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
  });

  it("marks the sequence cancelled exactly once on a 2xx, with no toast", async () => {
    const http = await renderAndCancel({ body: { success: true } });

    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText("1 of 2 sent")).toBeNull();
    // The Cancel control is only rendered for an active sequence.
    expect(screen.queryByText("Cancel")).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
    expect(http.unmatched).toEqual([]);
    // A successful cancel trusts its own optimistic update; no refetch.
    expect(http.countOf(LIST_ROUTE)).toBe(1);
  });

  it("re-syncs the list after a refused cancel", async () => {
    // The load effect's deps never change again, so without a re-sync a row the
    // server refused to cancel would keep offering a Cancel button forever.
    const http = await renderAndCancel({ status: 404, body: { error: "gone" } });

    expect(http.countOf(LIST_ROUTE)).toBe(2);
    expect(http.unmatched).toEqual([]);
  });
});

describe("ContactFollowUpStatus — failed load (CAR-183)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers a retry instead of rendering nothing when the list fails to load", async () => {
    // Unchecked, a non-2xx left `sequences` empty and the card returned null,
    // so a failed read looked identical to "this contact has no follow-ups".
    installFakeFetch({ [LIST_ROUTE]: { status: 500, body: { error: "boom" } } });

    await act(async () => {
      render(<ContactFollowUpStatus contactId={CONTACT_ID} />);
    });

    expect(screen.getByText("Couldn't load follow-up sequences.")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("renders nothing when the contact genuinely has no sequences", async () => {
    // The empty state must stay invisible: only a FAILED read earns the card.
    installFakeFetch({ [LIST_ROUTE]: { body: { sequences: [] } } });

    const { container } = render(<ContactFollowUpStatus contactId={CONTACT_ID} />);
    await act(async () => {});

    expect(container.textContent).toBe("");
  });
});

/**
 * CAR-207 review. This card is the surface a user is most likely to see after a
 * send driver dies between Gmail accepting a follow-up and the mark-sent write,
 * because the sweeper resolves that row to the terminal `failed` and then
 * completes the parent sequence in the same tick.
 *
 * It was counting `messages.length` as the sent total, so it affirmatively told
 * the user that a message of UNKNOWN delivery had been delivered.
 */
describe("ContactFollowUpStatus — an unconfirmed send (CAR-207)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const message = (id: number, status: string) => ({
    id,
    sequence_number: id,
    status,
    scheduled_send_at: "2026-07-03T12:00:00.000Z",
    sent_at: status === "sent" ? "2026-07-03T12:00:00.000Z" : null,
  });

  async function renderWith(sequence: Record<string, unknown>) {
    const http = installFakeFetch({ [LIST_ROUTE]: { body: { sequences: [sequence] } } });
    await act(async () => {
      render(<ContactFollowUpStatus contactId={CONTACT_ID} />);
    });
    return http;
  }

  it("counts only genuinely sent steps, and warns about the unconfirmed one", async () => {
    const http = await renderWith({
      id: SEQUENCE_ID,
      status: "completed",
      original_subject: "Coffee next week?",
      original_sent_at: "2026-07-01T12:00:00.000Z",
      messages: [message(1, "sent"), message(2, "failed")],
    });

    // The defect: this read "2 follow-ups sent" over a message that may never
    // have arrived. Singular, too, which the old copy also got wrong.
    expect(screen.getByText("1 follow-up sent")).toBeTruthy();
    expect(screen.queryByText("2 follow-ups sent")).toBeNull();
    expect(
      screen.getByText(
        "1 step could not be confirmed. It may already have been delivered, so check your Gmail Sent folder before emailing again.",
      ),
    ).toBeTruthy();
    expect(http.unmatched).toEqual([]);
  });

  it("warns on a still-active sequence too, without disturbing its progress line", async () => {
    await renderWith({
      id: SEQUENCE_ID,
      status: "active",
      original_subject: "Coffee next week?",
      original_sent_at: "2026-07-01T12:00:00.000Z",
      messages: [message(1, "sent"), message(2, "failed"), message(3, "pending")],
    });

    expect(screen.getByText("1 of 3 sent")).toBeTruthy();
    expect(screen.getByText(/1 step could not be confirmed/)).toBeTruthy();
  });

  it("says nothing extra when every step genuinely sent", async () => {
    await renderWith({
      id: SEQUENCE_ID,
      status: "completed",
      original_subject: "Coffee next week?",
      original_sent_at: "2026-07-01T12:00:00.000Z",
      messages: [message(1, "sent"), message(2, "sent")],
    });

    expect(screen.getByText("2 follow-ups sent")).toBeTruthy();
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
  });
});

// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";

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

const h = vi.hoisted(() => ({ toastError: vi.fn(), user: { id: "u-1" } }));

// The user object is hoisted rather than built per call on purpose: the
// component's load effect lists `user` in its dependency array, so a mock
// returning a fresh literal each render re-runs the effect forever.
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: h.user }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({
    toast: () => "",
    dismiss: () => {},
    success: () => {},
    error: h.toastError,
    info: () => {},
    warning: () => {},
  }),
}));

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
    h.toastError.mockClear();
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
    expect(h.toastError).toHaveBeenCalledWith(TOAST_COPY);
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
  });

  it("keeps the sequence active and toasts when the route answers 500", async () => {
    await renderAndCancel({
      status: 500,
      body: { error: "Something went wrong" },
    });

    expect(screen.getByText("1 of 2 sent")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(h.toastError).toHaveBeenCalledWith(TOAST_COPY);
  });

  it("keeps the sequence active and toasts when the request never lands", async () => {
    // The only failure the original bare try/catch could observe. It must stay
    // covered now that the check moved into apiSend.
    await renderAndCancel({ reject: new TypeError("Failed to fetch") });

    expect(screen.getByText("1 of 2 sent")).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(h.toastError).toHaveBeenCalledWith(TOAST_COPY);
  });

  it("marks the sequence cancelled exactly once on a 2xx, with no toast", async () => {
    const http = await renderAndCancel({ body: { success: true } });

    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText("1 of 2 sent")).toBeNull();
    // The Cancel control is only rendered for an active sequence.
    expect(screen.queryByText("Cancel")).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(http.countOf(CANCEL_ROUTE)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});

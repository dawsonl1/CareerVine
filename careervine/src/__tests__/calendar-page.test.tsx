// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-154 / F21: a failed calendar load must render a retryable error state,
 * not the "No events" empty card, and Retry must re-run the loaders.
 */

const q = vi.hoisted(() => ({
  getMeetings: vi.fn(),
  createMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  getContacts: vi.fn(),
  addContactsToMeeting: vi.fn(),
  replaceContactsForMeeting: vi.fn(),
}));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1" };
  return { useAuth: () => ({ user }) };
});
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), toast: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/hooks/use-gmail-connection", () => ({ useGmailConnection: () => ({ calendarConnected: true }) }));
vi.mock("@/lib/queries", () => q);

import CalendarPage from "@/app/calendar/page";

beforeEach(() => {
  vi.clearAllMocks();
  q.getContacts.mockResolvedValue([]);
  q.getMeetings.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CalendarPage — honest load-failure state (F21)", () => {
  it("renders a retryable error state when the events fetch fails", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("We could not load your calendar")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText("No events")).toBeNull();
  });

  it("re-runs the loaders when Retry is clicked", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network"); });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());

    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("renders the error state when the events API returns an HTTP error with a JSON body", async () => {
    // fetch does NOT reject on 4xx/5xx; the route returns {error} with no
    // `events` key. Without the res.ok check this read as load-empty.
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "An unexpected error occurred" }),
    })) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("We could not load your calendar")).toBeTruthy());
    expect(screen.queryByText("No events")).toBeNull();
  });

  it("shows the empty state (not the error state) on a successful empty load", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/api/calendar/sync")) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    }) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("No events")).toBeTruthy());
    expect(screen.queryByText("We could not load your calendar")).toBeNull();
  });

  it("keeps the calendar usable when only enrichment loaders fail", async () => {
    // Events succeed; contacts (enrichment) reject. The error state must not
    // show, and no stale flag may strand a later spurious error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    q.getContacts.mockRejectedValue(new Error("rls"));
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/api/calendar/sync")) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ id: 1, google_event_id: "g1", title: "Standup", description: null, start_at: "2026-07-17T15:00:00Z", end_at: "2026-07-17T15:30:00Z", all_day: false, location: null, meet_link: null, is_private: false, recurring_event_id: null, contact_id: null, attendees: [] }],
        }),
      };
    }) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("Standup")).toBeTruthy());
    expect(screen.queryByText("We could not load your calendar")).toBeNull();
  });
});

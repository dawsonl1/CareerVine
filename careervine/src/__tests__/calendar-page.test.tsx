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

/**
 * The attendee lookup (CAR-229). It lives in the domain module rather than the
 * frozen @/lib/queries barrel, so it needs its own mock — otherwise the page
 * reaches the real db() seam the moment an event carries an attendee.
 */
const attendees = vi.hoisted(() => ({ getContactsByEmail: vi.fn() }));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/hooks/use-gmail-connection", () => ({ useGmailConnection: () => ({ calendarConnected: true }) }));
vi.mock("@/lib/queries", () => q);
vi.mock("@/lib/data/meetings", () =>
  typedMock<typeof import("@/lib/data/meetings")>({
    getMeetings: vi.fn(),
    getMeetingsForContact: vi.fn(),
    createMeeting: vi.fn(),
    updateMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    replaceContactsForMeeting: vi.fn(),
    addContactsToMeeting: vi.fn(),
    createTranscriptSegments: vi.fn(),
    getTranscriptSegments: vi.fn(),
    getTranscriptSegmentsForMeetings: vi.fn(),
    getFirstEmailByContactId: vi.fn(),
    getContactsByEmail: attendees.getContactsByEmail,
    updateSpeakerContact: vi.fn(),
    deleteTranscriptSegments: vi.fn(),
  }),
);

import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { typedMock } from "./helpers/typed-mock";
import CalendarPage from "@/app/calendar/page";

beforeEach(() => {
  vi.clearAllMocks();
  q.getContacts.mockResolvedValue([]);
  q.getMeetings.mockResolvedValue([]);
  attendees.getContactsByEmail.mockResolvedValue(new Map());
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
    // Events succeed; the linked-meeting and attendee-name loaders (both
    // enrichment) reject. The error state must not show, no stale flag may
    // strand a later spurious error, and the attendee falls back to its raw
    // address rather than disappearing. The attendee read is the enrichment
    // loader as of CAR-229 — the full contact list is no longer part of the
    // page load at all, so rejecting getContacts here would prove nothing.
    vi.spyOn(console, "error").mockImplementation(() => {});
    q.getMeetings.mockRejectedValue(new Error("rls"));
    attendees.getContactsByEmail.mockRejectedValue(new Error("rls"));
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/api/calendar/sync")) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ id: 1, google_event_id: "g1", title: "Standup", description: null, start_at: "2026-07-17T15:00:00Z", end_at: "2026-07-17T15:30:00Z", all_day: false, location: null, meet_link: null, is_private: false, recurring_event_id: null, contact_id: null, attendees: [{ email: "jane@example.com", responseStatus: "accepted" }] }],
        }),
      };
    }) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("Standup")).toBeTruthy());
    await waitFor(() => expect(attendees.getContactsByEmail).toHaveBeenCalled());
    expect(screen.getByText("jane@example.com")).toBeTruthy();
    expect(screen.queryByText("We could not load your calendar")).toBeNull();
  });

  it("labels an attendee with the contact name the bounded lookup resolves", async () => {
    // The lookup is keyed by the addresses on the loaded events, NOT by pulling
    // the whole contact list (CAR-229) — so assert both that it was asked for
    // exactly those addresses and that its answer reaches the render.
    attendees.getContactsByEmail.mockResolvedValue(
      new Map([["jane@example.com", { id: 7, name: "Jane Doe" }]]),
    );
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/api/calendar/sync")) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ id: 1, google_event_id: "g1", title: "Standup", description: null, start_at: "2026-07-17T15:00:00Z", end_at: "2026-07-17T15:30:00Z", all_day: false, location: null, meet_link: null, is_private: false, recurring_event_id: null, contact_id: null, attendees: [{ email: "Jane@Example.com", responseStatus: "accepted" }] }],
        }),
      };
    }) as unknown as typeof fetch;

    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());
    // Lowercased on the way in: contact_emails is stored lower(trim())-normalized.
    expect(attendees.getContactsByEmail).toHaveBeenCalledWith(expect.any(String), ["jane@example.com"]);
    // The full contact list is never touched by a page load.
    expect(q.getContacts).not.toHaveBeenCalled();
  });
});

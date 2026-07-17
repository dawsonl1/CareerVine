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
afterEach(() => cleanup());

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
});

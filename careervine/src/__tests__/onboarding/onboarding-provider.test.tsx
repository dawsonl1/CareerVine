// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  OnboardingProvider,
  useOnboarding,
} from "@/components/onboarding/onboarding-provider";

// Mock useAuth so the provider believes a user is logged in.
// The user object must be stable across renders.
vi.mock("@/components/auth-provider", () => {
  const stableUser = { id: "user-123", email: "test@example.com" };
  return {
    useAuth: vi.fn(() => ({ user: stableUser })),
  };
});

// Mock useGmailConnection so the auto-advance effect never fires in unit tests.
vi.mock("@/hooks/use-gmail-connection", () => ({
  useGmailConnection: vi.fn(() => ({
    data: null,
    loading: false,
    refresh: vi.fn(),
    calendarConnected: false,
    calendarLastSynced: null,
  })),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function wrapper({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider>{children}</OnboardingProvider>;
}

function makeResponse(data: unknown) {
  return { ok: true, json: async () => data };
}

describe("useOnboarding", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("seeds onboarding and populates state when no record exists", async () => {
    // First: status returns null (no record)
    mockFetch.mockResolvedValueOnce(makeResponse({ onboarding: null }));
    // Second: setup POST
    mockFetch.mockResolvedValueOnce(makeResponse({ status: "setup_complete" }));
    // Third: re-fetch status after setup
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isActive).toBe(true);
    expect(result.current.currentStepId).toBe("connect_gmail");
  });

  it("populates state when onboarding data is returned", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isActive).toBe(true);
    expect(result.current.currentStepId).toBe("connect_gmail");
    expect(result.current.currentStep?.title).toBe("Connect Your Gmail");
    expect(result.current.version).toBe(1);
    expect(result.current.progress).toBeGreaterThan(0);
  });

  it("isActive is false when step is 'complete'", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ onboarding: { current_step: "complete", version: 2 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isActive).toBe(false);
    expect(result.current.currentStepId).toBe("complete");
  });

  it("advance POSTs and computes next step client-side", async () => {
    // Status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );
    // Advance POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ nextStep: { id: "connect_calendar" }, completed: false })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    await result.current.advance();

    // Next step is computed client-side from getNextStep("connect_gmail")
    await waitFor(() =>
      expect(result.current.currentStepId).toBe("connect_calendar")
    );

    const advanceCall = mockFetch.mock.calls.find(([url]: [string]) =>
      String(url).includes("/api/onboarding/advance")
    );
    expect(advanceCall).toBeDefined();
    expect(advanceCall![1].method).toBe("POST");
    const body = JSON.parse(advanceCall![1].body);
    expect(body.currentStep).toBe("connect_gmail");
  });

  it("advanceIfStep does nothing when stepId does not match", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    const callsBefore = mockFetch.mock.calls.length;

    await result.current.advanceIfStep("connect_calendar");

    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("advanceIfStep advances when stepId matches", async () => {
    // Status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );
    // Advance POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ nextStep: { id: "connect_calendar" }, completed: false })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    await result.current.advanceIfStep("connect_gmail");

    await waitFor(() =>
      expect(result.current.currentStepId).toBe("connect_calendar")
    );
  });

  it("skip POSTs and sets state to complete", async () => {
    // Status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step: "connect_gmail", version: 1 } })
    );
    // Skip POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ status: "skipped" })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    await result.current.skip();

    await waitFor(() => expect(result.current.currentStepId).toBe("complete"));

    const skipCall = mockFetch.mock.calls.find(([url]: [string]) =>
      String(url).includes("/api/onboarding/skip")
    );
    expect(skipCall).toBeDefined();
    expect(skipCall![1].method).toBe("POST");
  });
});

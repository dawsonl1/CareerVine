// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  OnboardingProvider,
  useOnboarding,
} from "@/components/onboarding/onboarding-provider";

// Mock useAuth so the provider believes a user is logged in.
// The user object must be stable across renders — a new object literal on every
// call would change the `user` reference, causing the useCallback/useEffect in
// the provider to fire multiple times and consume extra mockResolvedValueOnce entries.
vi.mock("@/components/auth-provider", () => {
  const stableUser = { id: "user-123", email: "test@example.com" };
  return {
    useAuth: vi.fn(() => ({ user: stableUser })),
  };
});

// Replace global fetch with a vi.fn() at module level so it is always a mock
const mockFetch = vi.fn();
global.fetch = mockFetch;

function wrapper({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider>{children}</OnboardingProvider>;
}

// Helper: make a resolved fetch response
function makeResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
  };
}

describe("useOnboarding", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("provides default state when no onboarding data", async () => {
    mockFetch.mockResolvedValue(makeResponse({ onboarding: null }));

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    // Wait for the initial status fetch to resolve
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isActive).toBe(false);
    expect(result.current.currentStep).toBeNull();
    expect(result.current.currentStepId).toBeNull();
    expect(result.current.progress).toBe(0);
    expect(result.current.version).toBeNull();
  });

  it("populates state when onboarding data is returned", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ onboarding: { current_step_id: "connect_gmail", version: 1 } })
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
      makeResponse({ onboarding: { current_step_id: "complete", version: 2 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isActive).toBe(false);
    expect(result.current.currentStepId).toBe("complete");
  });

  it("advance POSTs to /api/onboarding/advance and updates state", async () => {
    // First call: initial status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "connect_gmail", version: 1 } })
    );
    // Second call: advance POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "connect_calendar", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    await result.current.advance();

    await waitFor(() =>
      expect(result.current.currentStepId).toBe("connect_calendar")
    );

    const advanceCall = mockFetch.mock.calls.find(([url]: [string]) =>
      String(url).includes("/api/onboarding/advance")
    );
    expect(advanceCall).toBeDefined();
    expect(advanceCall![1].method).toBe("POST");
  });

  it("advanceIfStep does nothing when stepId does not match", async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ onboarding: { current_step_id: "connect_gmail", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    const callsBefore = mockFetch.mock.calls.length;

    // Different step ID — should be a no-op
    await result.current.advanceIfStep("connect_calendar");

    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("advanceIfStep advances when stepId matches", async () => {
    // First call: initial status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "connect_gmail", version: 1 } })
    );
    // Second call: advance POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "connect_calendar", version: 1 } })
    );

    const { result } = renderHook(() => useOnboarding(), { wrapper });

    await waitFor(() => expect(result.current.currentStepId).toBe("connect_gmail"));

    await result.current.advanceIfStep("connect_gmail");

    await waitFor(() =>
      expect(result.current.currentStepId).toBe("connect_calendar")
    );
  });

  it("skip POSTs to /api/onboarding/skip and updates state", async () => {
    // First call: initial status fetch
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "connect_gmail", version: 1 } })
    );
    // Second call: skip POST
    mockFetch.mockResolvedValueOnce(
      makeResponse({ onboarding: { current_step_id: "complete", version: 1 } })
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

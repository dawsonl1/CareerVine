// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Regression tests for the CAR-68 deep-review's top UI finding: the "done"
 * celebration screen was dead code because an isExtensionOnboardingDone()
 * guard returned null before its JSX could render. These tests mount the real
 * modal at each terminal state and assert done renders its finale while
 * completed_no_apollo renders nothing.
 */

const mockSnapshot = vi.fn();

vi.mock("@/lib/onboarding/extension-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/onboarding/extension-state")>();
  return {
    ...original,
    getExtensionOnboardingSnapshot: (...args: unknown[]) => mockSnapshot(...args),
    advanceExtensionOnboardingState: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" }, loading: false }),
}));
vi.mock("@/lib/queries", () => ({
  updateActionItem: vi.fn().mockResolvedValue(undefined),
  deleteActionItem: vi.fn().mockResolvedValue(undefined),
  getOnboardingActionItemId: vi.fn().mockResolvedValue(1),
}));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ExtensionOnboardingModal } from "@/components/onboarding/extension-onboarding-modal";
import {
  ExtensionOnboardingProvider,
  useExtensionOnboarding,
} from "@/components/onboarding/extension-onboarding-context";

function OpenOnMount() {
  const { open } = useExtensionOnboarding();
  useEffect(() => {
    open(1);
  }, [open]);
  return null;
}

function renderModal() {
  return render(
    <ExtensionOnboardingProvider>
      <OpenOnMount />
      <ExtensionOnboardingModal />
    </ExtensionOnboardingProvider>,
  );
}

afterEach(cleanup);
// Clear call history between tests (keeps implementations) — completeTodo
// calls from one test must not bleed into the next test's assertions.
beforeEach(() => vi.clearAllMocks());

describe("ExtensionOnboardingModal terminal states (CAR-68)", () => {
  it("renders the finale celebration for state 'done' (was dead code)", async () => {
    mockSnapshot.mockResolvedValue({
      state: "done",
      contactId: 42,
      extensionLastSeenAt: "2026-07-11T00:00:00Z",
    });
    renderModal();
    expect(await screen.findByText(/networking machine/i)).toBeTruthy();
    // The alternatives slide-in exists in the DOM (revealed after a delay).
    expect(screen.getByText("Hunter.io")).toBeTruthy();
  });

  it("renders nothing for state 'completed_no_apollo'", async () => {
    mockSnapshot.mockResolvedValue({
      state: "completed_no_apollo",
      contactId: 42,
      extensionLastSeenAt: null,
    });
    const { container } = renderModal();
    // Give the open-load effect a tick to resolve.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".relative")).toBeNull();
    expect(screen.queryByText(/networking machine/i)).toBeNull();
  });

  it("closes instead of fabricating a state when the initial read fails", async () => {
    mockSnapshot.mockResolvedValue(null);
    renderModal();
    await new Promise((r) => setTimeout(r, 20));
    // No step rendered, and crucially no false "done" side effects.
    expect(screen.queryByText(/networking machine/i)).toBeNull();
    expect(screen.queryByText(/Import contacts straight from LinkedIn/i)).toBeNull();
    const { updateActionItem } = await import("@/lib/queries");
    expect(vi.mocked(updateActionItem)).not.toHaveBeenCalled();
  });

  it("renders the intro for a fresh 'not_started' user", async () => {
    mockSnapshot.mockResolvedValue({
      state: "not_started",
      contactId: null,
      extensionLastSeenAt: null,
    });
    renderModal();
    expect(await screen.findByText(/Import contacts straight from LinkedIn/i)).toBeTruthy();
    expect(screen.getByText(/Start \(est\. 3 min\)/i)).toBeTruthy();
  });
});

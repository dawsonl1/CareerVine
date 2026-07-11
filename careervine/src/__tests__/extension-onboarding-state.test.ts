import { describe, it, expect } from "vitest";
import {
  canAdvance,
  isExtensionOnboardingDone,
  type ExtensionOnboardingState,
} from "@/lib/onboarding/extension-state";

const ORDER: ExtensionOnboardingState[] = [
  "not_started",
  "started",
  "awaiting_connect",
  "awaiting_first_contact",
  "email_offer",
  "apollo_intro",
  "apollo_install",
  "apollo_howto",
  "awaiting_email_contact",
  "done",
];

describe("extension onboarding state machine (CAR-68)", () => {
  it("allows only forward transitions along the flow", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        expect(canAdvance(ORDER[i], ORDER[j])).toBe(j > i);
      }
    }
  });

  it("treats completed_no_apollo as terminal in both directions", () => {
    expect(canAdvance("completed_no_apollo", "done")).toBe(false);
    expect(canAdvance("done", "completed_no_apollo")).toBe(false);
    expect(canAdvance("completed_no_apollo", "apollo_intro")).toBe(false);
    // Any live state can still exit via the no-apollo branch.
    expect(canAdvance("email_offer", "completed_no_apollo")).toBe(true);
    expect(canAdvance("not_started", "completed_no_apollo")).toBe(true);
  });

  it("supports the already-connected fast-forward jump", () => {
    // Start with the extension already connected skips install+login.
    expect(canAdvance("not_started", "awaiting_first_contact")).toBe(true);
  });

  it("marks only the two terminal states as done", () => {
    for (const s of ORDER.slice(0, -1)) {
      expect(isExtensionOnboardingDone(s)).toBe(false);
    }
    expect(isExtensionOnboardingDone("done")).toBe(true);
    expect(isExtensionOnboardingDone("completed_no_apollo")).toBe(true);
  });
});

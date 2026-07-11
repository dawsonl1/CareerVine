import { describe, it, expect } from "vitest";
import { canAdvance, isOnboardingActive, type OnboardingState } from "@/lib/onboarding/state";

const ORDER: OnboardingState[] = ["not_started", "connect", "syncing", "pick_company", "outreach", "completed"];

describe("onboarding state machine", () => {
  it("allows only forward transitions along the flow", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        expect(canAdvance(ORDER[i], ORDER[j])).toBe(j > i);
      }
    }
  });

  it("treats skipped as terminal in both directions", () => {
    expect(canAdvance("skipped", "completed")).toBe(false);
    expect(canAdvance("skipped", "syncing")).toBe(false);
    expect(canAdvance("completed", "skipped")).toBe(false);
    // Any live state can still be skipped.
    expect(canAdvance("not_started", "skipped")).toBe(true);
    expect(canAdvance("outreach", "skipped")).toBe(true);
  });

  it("places the connect step between the offer and the sync (CAR-82)", () => {
    // Accept → connect → syncing, forward-only; a closed tab on connect
    // resumes on connect, never skips ahead to the picker.
    expect(canAdvance("not_started", "connect")).toBe(true);
    expect(canAdvance("connect", "syncing")).toBe(true);
    expect(canAdvance("connect", "pick_company")).toBe(true);
    expect(canAdvance("syncing", "connect")).toBe(false);
    expect(canAdvance("connect", "not_started")).toBe(false);
    expect(canAdvance("connect", "skipped")).toBe(true);
    expect(isOnboardingActive("connect")).toBe(true);
  });

  it("marks only pre-terminal states as active", () => {
    expect(isOnboardingActive("not_started")).toBe(true);
    expect(isOnboardingActive("syncing")).toBe(true);
    expect(isOnboardingActive("pick_company")).toBe(true);
    expect(isOnboardingActive("outreach")).toBe(true);
    expect(isOnboardingActive("completed")).toBe(false);
    expect(isOnboardingActive("skipped")).toBe(false);
  });
});

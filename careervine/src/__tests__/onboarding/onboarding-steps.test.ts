import { describe, it, expect } from "vitest";
import { ONBOARDING_STEPS, getStepIndex, getStepById } from "@/components/onboarding/onboarding-steps";

describe("onboarding steps", () => {
  it("has exactly 14 steps", () => {
    expect(ONBOARDING_STEPS).toHaveLength(14);
  });

  it("each step has required fields", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.description).toBeTruthy();
      expect(step.page).toBeTruthy();
    }
  });

  it("step IDs are unique", () => {
    const ids = ONBOARDING_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getStepIndex returns correct index", () => {
    expect(getStepIndex("connect_gmail")).toBe(0);
    expect(getStepIndex("wispr_recommendation")).toBe(13);
  });

  it("getStepById returns correct step", () => {
    const step = getStepById("install_cv_extension");
    expect(step?.title).toContain("Chrome Extension");
  });
});

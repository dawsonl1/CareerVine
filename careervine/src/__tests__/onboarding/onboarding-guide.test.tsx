// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingGuide } from "@/components/onboarding/onboarding-guide";

vi.mock("@/components/onboarding/onboarding-provider", () => ({
  useOnboarding: () => ({
    isActive: true,
    currentStep: {
      id: "connect_gmail",
      title: "Connect your Gmail",
      description: "Let's connect your Gmail.",
      page: "/",
      primaryAction: { label: "Connect Gmail", action: "oauth_gmail" },
      skippable: false,
      advanceOn: "automatic",
    },
    currentStepId: "connect_gmail",
    progress: 0,
    advance: vi.fn(),
    skip: vi.fn(),
    advanceIfStep: vi.fn(),
  }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { user_metadata: { first_name: "Test" } },
  }),
}));

describe("OnboardingGuide", () => {
  it("renders the current step title and description", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("Connect your Gmail")).toBeTruthy();
    expect(screen.getByText("Let's connect your Gmail.")).toBeTruthy();
  });

  it("shows progress indicator", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("1/14")).toBeTruthy();
  });

  it("renders skip tutorial link", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("Skip tutorial")).toBeTruthy();
  });
});

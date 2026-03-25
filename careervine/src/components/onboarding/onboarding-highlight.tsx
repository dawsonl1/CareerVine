"use client";

import { useEffect } from "react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";

/**
 * OnboardingHighlight manages the DOM-level highlight overlay during onboarding.
 *
 * It finds elements tagged with `data-onboarding-target` matching the current
 * step's highlightTarget and applies the `onboarding-highlight` CSS class to
 * them. It also renders a semi-transparent backdrop when a highlight is active.
 */
export function OnboardingHighlight() {
  const { isActive, currentStep } = useOnboarding();

  const highlightTarget = currentStep?.highlightTarget ?? null;

  useEffect(() => {
    if (!isActive || !highlightTarget) return;

    const elements = document.querySelectorAll<HTMLElement>(
      `[data-onboarding-target="${highlightTarget}"]`
    );

    elements.forEach((el) => el.classList.add("onboarding-highlight"));

    return () => {
      elements.forEach((el) => el.classList.remove("onboarding-highlight"));
    };
  }, [isActive, highlightTarget]);

  if (!isActive || !highlightTarget) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-[998] pointer-events-none" />
  );
}

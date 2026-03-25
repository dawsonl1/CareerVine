"use client";

import { useEffect } from "react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";

/**
 * OnboardingHighlight continuously watches for elements tagged with
 * `data-onboarding-target` matching the current step's highlightTarget
 * and applies the `onboarding-highlight` CSS class.
 *
 * Uses a MutationObserver that stays active for the lifetime of the step
 * so highlights survive page navigation and React re-renders.
 */
export function OnboardingHighlight() {
  const { isActive, currentStep } = useOnboarding();
  const highlightTarget = currentStep?.highlightTarget ?? null;

  useEffect(() => {
    if (!isActive || !highlightTarget) return;

    const selector = `[data-onboarding-target="${highlightTarget}"]`;

    const applyHighlights = () => {
      document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        if (!el.classList.contains("onboarding-highlight")) {
          el.classList.add("onboarding-highlight");
        }
      });
    };

    // Apply immediately for already-mounted elements
    applyHighlights();

    // Keep watching so highlights survive navigation and React re-renders
    const observer = new MutationObserver(applyHighlights);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      document
        .querySelectorAll<HTMLElement>(".onboarding-highlight")
        .forEach((el) => el.classList.remove("onboarding-highlight"));
    };
  }, [isActive, highlightTarget]);

  return null;
}

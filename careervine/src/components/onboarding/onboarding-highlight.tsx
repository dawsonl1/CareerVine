"use client";

import { useEffect, useState } from "react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";

/**
 * OnboardingHighlight manages the DOM-level highlight overlay during onboarding.
 *
 * It finds elements tagged with `data-onboarding-target` matching the current
 * step's highlightTarget and applies the `onboarding-highlight` CSS class to
 * them. It also renders a semi-transparent backdrop — but only when at least
 * one matching element is found in the DOM, preventing a dimmed screen with
 * nothing highlighted.
 */
export function OnboardingHighlight() {
  const { isActive, currentStep } = useOnboarding();

  const highlightTarget = currentStep?.highlightTarget ?? null;
  const [hasTargets, setHasTargets] = useState(false);

  useEffect(() => {
    if (!isActive || !highlightTarget) {
      setHasTargets(false);
      return;
    }

    // Defer one frame so the target page's React tree commits before we query
    const raf = requestAnimationFrame(() => {
      const elements = document.querySelectorAll<HTMLElement>(
        `[data-onboarding-target="${highlightTarget}"]`
      );
      setHasTargets(elements.length > 0);
      elements.forEach((el) => el.classList.add("onboarding-highlight"));
    });

    return () => {
      cancelAnimationFrame(raf);
      setHasTargets(false);
      document
        .querySelectorAll<HTMLElement>(".onboarding-highlight")
        .forEach((el) => el.classList.remove("onboarding-highlight"));
    };
  }, [isActive, highlightTarget]);

  if (!isActive || !highlightTarget || !hasTargets) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-[998] pointer-events-none" />
  );
}

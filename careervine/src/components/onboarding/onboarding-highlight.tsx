"use client";

import { useEffect, useState, useRef } from "react";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";
import { usePathname } from "next/navigation";

/**
 * OnboardingHighlight manages the DOM-level highlight overlay during onboarding.
 *
 * It finds elements tagged with `data-onboarding-target` matching the current
 * step's highlightTarget and applies the `onboarding-highlight` CSS class to
 * them. It also renders a semi-transparent backdrop — but only when at least
 * one matching element is found in the DOM, preventing a dimmed screen with
 * nothing highlighted.
 *
 * Uses a MutationObserver to detect when target elements appear after
 * client-side navigation (since the effect dependencies don't change on route change).
 */
export function OnboardingHighlight() {
  const { isActive, currentStep } = useOnboarding();
  const pathname = usePathname();

  const highlightTarget = currentStep?.highlightTarget ?? null;
  const [hasTargets, setHasTargets] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    if (!isActive || !highlightTarget) {
      setHasTargets(false);
      return;
    }

    const applyHighlights = () => {
      const elements = document.querySelectorAll<HTMLElement>(
        `[data-onboarding-target="${highlightTarget}"]`
      );
      setHasTargets(elements.length > 0);
      elements.forEach((el) => el.classList.add("onboarding-highlight"));
      return elements.length > 0;
    };

    // Try immediately after a frame (for already-mounted elements)
    const raf = requestAnimationFrame(() => {
      if (!applyHighlights()) {
        // Target not found yet — watch for it via MutationObserver
        observerRef.current = new MutationObserver(() => {
          if (applyHighlights()) {
            // Found it — stop observing
            observerRef.current?.disconnect();
            observerRef.current = null;
          }
        });
        observerRef.current.observe(document.body, {
          childList: true,
          subtree: true,
        });
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      observerRef.current?.disconnect();
      observerRef.current = null;
      setHasTargets(false);
      document
        .querySelectorAll<HTMLElement>(".onboarding-highlight")
        .forEach((el) => el.classList.remove("onboarding-highlight"));
    };
  }, [isActive, highlightTarget, pathname]);

  if (!isActive || !highlightTarget || !hasTargets) return null;

  return (
    <div className="fixed inset-0 bg-black/30 z-[998] pointer-events-none" />
  );
}

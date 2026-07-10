"use client";

/**
 * Guided-onboarding state machine (CAR-50).
 *
 * Owns the persisted flow position (users.onboarding_state), the finale
 * trigger, and the funnel analytics. The step UI lives in
 * onboarding-flow.tsx; company pages read this context to render the
 * outreach-leg nudge and template-prefilled compose.
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { track } from "@/lib/analytics/client";
import {
  getOnboardingState,
  advanceOnboardingState,
  type OnboardingState,
} from "@/lib/onboarding/state";

type OnboardingContextValue = {
  /** null while the persisted state is loading — render nothing until known. */
  state: OnboardingState | null;
  /** True between the onboarding email being sent and "Grow your Career Vine". */
  showFinale: boolean;
  advance: (next: OnboardingState) => void;
  skip: (atStep: string) => void;
  finishFinale: () => void;
};

const OnboardingContext = createContext<OnboardingContextValue>({
  state: null,
  showFinale: false,
  advance: () => {},
  skip: () => {},
  finishFinale: () => {},
});

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [showFinale, setShowFinale] = useState(false);
  const startedTracked = useRef(false);

  useEffect(() => {
    if (!user) {
      setState(null);
      return;
    }
    let cancelled = false;
    getOnboardingState(user.id).then((s) => {
      if (cancelled) return;
      setState(s);
      if (s === "not_started" && !startedTracked.current) {
        startedTracked.current = true;
        track("onboarding_started", {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const advance = useCallback(
    (next: OnboardingState) => {
      if (!user) return;
      // Optimistic: the UI moves immediately; the persisted write reconciles
      // (forward-only, so a lost race just means another tab was ahead).
      setState((prev) => (prev === null ? prev : next));
      advanceOnboardingState(user.id, next).then((persisted) => {
        setState((prev) => (prev === next ? persisted : prev));
      });
    },
    [user],
  );

  const skip = useCallback(
    (atStep: string) => {
      track("onboarding_skipped", { at_step: atStep });
      advance("skipped");
    },
    [advance],
  );

  // The outreach leg completes when any email goes out while the flow is in
  // 'outreach' — the composer fires this event on both send and schedule.
  useEffect(() => {
    if (state !== "outreach") return;
    const onSent = () => {
      track("onboarding_email_sent", {});
      setShowFinale(true);
    };
    window.addEventListener("careervine:email-sent", onSent);
    return () => window.removeEventListener("careervine:email-sent", onSent);
  }, [state]);

  const finishFinale = useCallback(() => {
    setShowFinale(false);
    track("onboarding_completed", {});
    advance("completed");
  }, [advance]);

  return (
    <OnboardingContext.Provider value={{ state, showFinale, advance, skip, finishFinale }}>
      {children}
    </OnboardingContext.Provider>
  );
}

"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import {
  getStepById,
  getProgress,
  type OnboardingStep,
} from "@/components/onboarding/onboarding-steps";

// Shape of the onboarding context exposed to all child components
interface OnboardingState {
  isActive: boolean;
  currentStep: OnboardingStep | null;
  currentStepId: string | null;
  progress: number;
  version: number | null;
  loading: boolean;
  advance: (skippedApollo?: boolean) => Promise<void>;
  skip: () => Promise<void>;
  advanceIfStep: (stepId: string, skippedApollo?: boolean) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingState>({
  isActive: false,
  currentStep: null,
  currentStepId: null,
  progress: 0,
  version: null,
  loading: false,
  advance: async () => {},
  skip: async () => {},
  advanceIfStep: async () => {},
  refreshStatus: async () => {},
});

export function useOnboarding(): OnboardingState {
  return useContext(OnboardingContext);
}

/**
 * OnboardingProvider manages the onboarding walkthrough state for the entire app.
 * It fetches the user's current onboarding position on mount and provides
 * actions for advancing or skipping steps to all child components.
 */
export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { data: gmailData, calendarConnected } = useGmailConnection();

  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch the user's current onboarding status from the API
  const refreshStatus = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await fetch("/api/onboarding/status");
      if (!res.ok) return;
      const data = await res.json();
      const onboarding = data?.onboarding ?? null;
      setCurrentStepId(onboarding?.current_step_id ?? null);
      setVersion(onboarding?.version ?? null);
    } catch {
      // Network errors are silently ignored — onboarding is non-critical
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Load status whenever the logged-in user changes
  useEffect(() => {
    if (user) {
      refreshStatus();
    } else {
      // Clear state on sign-out
      setCurrentStepId(null);
      setVersion(null);
    }
  }, [user, refreshStatus]);

  // Advance to the next step, optionally recording that Apollo was skipped
  const advance = useCallback(async (skippedApollo?: boolean) => {
    try {
      const body: Record<string, unknown> = {};
      if (skippedApollo !== undefined) body.skipped_apollo = skippedApollo;
      const res = await fetch("/api/onboarding/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
      const data = await res.json();
      const onboarding = data?.onboarding ?? null;
      setCurrentStepId(onboarding?.current_step_id ?? null);
      setVersion(onboarding?.version ?? null);
    } catch {
      // Silently ignore — onboarding advancement is best-effort
    }
  }, []);

  // Skip the entire onboarding flow
  const skip = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/skip", { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      const onboarding = data?.onboarding ?? null;
      setCurrentStepId(onboarding?.current_step_id ?? null);
      setVersion(onboarding?.version ?? null);
    } catch {
      // Silently ignore
    }
  }, []);

  // Auto-advance when the provider loads on an integration step that is already completed.
  // This prevents users from getting stuck on "Connect Gmail" or "Connect Calendar"
  // if they have already connected those integrations.
  useEffect(() => {
    if (!currentStepId || !user) return;
    if (
      currentStepId !== "connect_gmail" &&
      currentStepId !== "connect_calendar"
    )
      return;

    let cancelled = false;

    const checkIntegrations = async () => {
      // gmailData being non-null means Gmail OAuth is connected
      const gmailConnected = gmailData !== null;

      if (cancelled) return;

      if (currentStepId === "connect_gmail" && gmailConnected) {
        await advance();
      } else if (currentStepId === "connect_calendar" && calendarConnected) {
        await advance();
      }
    };

    checkIntegrations();

    return () => {
      cancelled = true;
    };
  }, [currentStepId, user, gmailData, calendarConnected, advance]);

  // Advance only when the current step matches the given stepId.
  // This is used by other components to auto-advance after completing an action
  // (e.g., compose modal calls advanceIfStep("compose_send_email") after sending).
  const advanceIfStep = useCallback(
    async (stepId: string, skippedApollo?: boolean) => {
      if (currentStepId !== stepId) return;
      await advance(skippedApollo);
    },
    [currentStepId, advance]
  );

  // Derived state
  const currentStep = currentStepId ? (getStepById(currentStepId) ?? null) : null;
  const progress = currentStepId ? getProgress(currentStepId) : 0;
  // isActive: not loading, has a recognized step, and that step is not "complete"
  const isActive = !loading && currentStepId !== null && currentStepId !== "complete";

  return (
    <OnboardingContext.Provider
      value={{
        isActive,
        currentStep,
        currentStepId,
        progress,
        version,
        loading,
        advance,
        skip,
        advanceIfStep,
        refreshStatus,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

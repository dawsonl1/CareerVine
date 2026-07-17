/**
 * Guided-onboarding flow state (CAR-50).
 *
 * users.onboarding_state is the single persisted flag: it decides whether the
 * first-run experience opens at all, and which step to resume after an
 * interrupted session (closed tab mid-sync, abandoned picker, etc.).
 * Transitions are forward-only — a refresh must never march the user backward
 * or re-show a finished intro.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { OnboardingState } from "@/lib/app-types";

export type { OnboardingState };

// Rank encodes flow order; the two terminal states share the top rank so
// neither can be "advanced" out of.
const STATE_RANK: Record<OnboardingState, number> = {
  not_started: 0,
  connect: 1,
  syncing: 2,
  pick_company: 3,
  outreach: 4,
  completed: 5,
  skipped: 5,
};

export function isOnboardingActive(state: OnboardingState): boolean {
  return STATE_RANK[state] < STATE_RANK.completed;
}

export function canAdvance(current: OnboardingState, next: OnboardingState): boolean {
  return STATE_RANK[next] > STATE_RANK[current];
}

export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("users")
    .select("onboarding_state")
    .eq("id", userId)
    .maybeSingle();
  // Fail closed to "completed": a transient read error must not re-open the
  // intro over a working dashboard.
  if (error || !data) return "completed";
  // onboarding_state is a text column whose CHECK constraint enumerates exactly
  // OnboardingState's members, so the stored value is always a valid state.
  return data.onboarding_state as OnboardingState;
}

/**
 * Advance to `next` if it is forward of the current state; returns the state
 * that is actually persisted afterward. Callers can fire-and-forget — a lost
 * race just means another tab already moved further ahead.
 */
export async function advanceOnboardingState(
  userId: string,
  next: OnboardingState,
): Promise<OnboardingState> {
  const supabase = createSupabaseBrowserClient();
  const current = await getOnboardingState(userId);
  if (!canAdvance(current, next)) return current;
  const { error } = await supabase
    .from("users")
    .update({ onboarding_state: next })
    .eq("id", userId);
  return error ? current : next;
}

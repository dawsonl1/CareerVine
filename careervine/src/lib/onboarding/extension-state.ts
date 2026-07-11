/**
 * Extension-onboarding flow state (CAR-68).
 *
 * users.extension_onboarding_state resumes the guided extension-import flow
 * across sessions: which modal step to show, and whether the seeded home-page
 * to-do should still open the flow at all. Transitions are forward-only — a
 * refresh must never march the user backward or re-show a finished flow.
 *
 * The waiting states (awaiting_connect / awaiting_first_contact /
 * awaiting_email_contact) are advanced server-side: the API layer stamps
 * users.extension_last_seen_at on extension calls, and /api/contacts/import
 * moves the state when the qualifying contact arrives. The client only polls.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { ExtensionOnboardingState } from "@/lib/database.types";

export type { ExtensionOnboardingState };

// Rank encodes flow order; the two terminal states share the top rank so
// neither can be "advanced" out of. email_offer's Yes/No fork rejoins a single
// line: completed_no_apollo is a terminal exit, not a parallel branch.
const STATE_RANK: Record<ExtensionOnboardingState, number> = {
  not_started: 0,
  started: 1,
  awaiting_connect: 2,
  awaiting_first_contact: 3,
  email_offer: 4,
  apollo_intro: 5,
  apollo_install: 6,
  apollo_howto: 7,
  awaiting_email_contact: 8,
  done: 9,
  completed_no_apollo: 9,
};

export function isExtensionOnboardingDone(state: ExtensionOnboardingState): boolean {
  return STATE_RANK[state] >= STATE_RANK.done;
}

export function canAdvance(
  current: ExtensionOnboardingState,
  next: ExtensionOnboardingState,
): boolean {
  return STATE_RANK[next] > STATE_RANK[current];
}

export type ExtensionOnboardingSnapshot = {
  state: ExtensionOnboardingState;
  contactId: number | null;
  extensionLastSeenAt: string | null;
};

export async function getExtensionOnboardingSnapshot(
  userId: string,
): Promise<ExtensionOnboardingSnapshot> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("users")
    .select("extension_onboarding_state, extension_onboarding_contact_id, extension_last_seen_at")
    .eq("id", userId)
    .maybeSingle();
  // Fail closed to "done": a transient read error must not pop the flow open
  // over a working dashboard.
  if (error || !data) {
    return { state: "done", contactId: null, extensionLastSeenAt: null };
  }
  return {
    state: data.extension_onboarding_state,
    contactId: data.extension_onboarding_contact_id,
    extensionLastSeenAt: data.extension_last_seen_at,
  };
}

/**
 * Advance to `next` if it is forward of the current state; returns the state
 * actually persisted afterward. Callers can fire-and-forget — a lost race just
 * means the server (or another tab) already moved further ahead.
 */
export async function advanceExtensionOnboardingState(
  userId: string,
  next: ExtensionOnboardingState,
): Promise<ExtensionOnboardingState> {
  const supabase = createSupabaseBrowserClient();
  const { state: current } = await getExtensionOnboardingSnapshot(userId);
  if (!canAdvance(current, next)) return current;
  const { error } = await supabase
    .from("users")
    .update({ extension_onboarding_state: next })
    .eq("id", userId);
  return error ? current : next;
}

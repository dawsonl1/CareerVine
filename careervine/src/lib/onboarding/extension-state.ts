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
 *
 * Read failures are surfaced as `null`, never as a fabricated state — the
 * deep-review found that failing closed to "done" let one transient poll
 * error falsely complete the whole flow (retire the to-do + fire a bogus
 * completion event). Callers decide: the modal's initial load treats null as
 * "don't open", the poll treats it as "keep the current step and retry".
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import type { ExtensionOnboardingState } from "@/lib/app-types";

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

/**
 * Read the user's flow snapshot. Returns `null` when the read fails or the
 * row is missing — callers must treat that as "unknown", not as any state.
 */
export async function getExtensionOnboardingSnapshot(
  userId: string,
): Promise<ExtensionOnboardingSnapshot | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("users")
    .select("extension_onboarding_state, extension_onboarding_contact_id, extension_last_seen_at")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    // extension_onboarding_state is CHECK-constrained to ExtensionOnboardingState's members.
    state: data.extension_onboarding_state as ExtensionOnboardingState,
    contactId: data.extension_onboarding_contact_id,
    extensionLastSeenAt: data.extension_last_seen_at,
  };
}

/**
 * Advance to `next` if it is forward of the current state; returns the state
 * actually persisted afterward, or `null` when the current state couldn't be
 * read (nothing was written). The write is a compare-and-swap on the state
 * read moments earlier, checked via `count` (never `.select()` — rule 17:
 * PostgREST re-applies request filters to RETURNING, so a successful CAS on
 * the filtered column reads back as zero rows). A zero count means another
 * writer (a concurrent server advance, another tab) moved the row first —
 * re-read and report where it actually landed.
 */
export async function advanceExtensionOnboardingState(
  userId: string,
  next: ExtensionOnboardingState,
): Promise<ExtensionOnboardingState | null> {
  const supabase = createSupabaseBrowserClient();
  const snapshot = await getExtensionOnboardingSnapshot(userId);
  if (!snapshot) return null;
  const current = snapshot.state;
  if (!canAdvance(current, next)) return current;

  const { error, count } = await supabase
    .from("users")
    .update({ extension_onboarding_state: next }, { count: "exact" })
    .eq("id", userId)
    .eq("extension_onboarding_state", current);
  if (error) return current;
  if (count === 0) {
    // Lost the race — someone else advanced first. Report the fresh truth.
    const fresh = await getExtensionOnboardingSnapshot(userId);
    return fresh?.state ?? current;
  }
  return next;
}

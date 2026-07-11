/**
 * Server-side extension-onboarding advancement (CAR-68).
 *
 * The flow's waiting steps are advanced here, inside the events themselves
 * (/api/contacts/import), rather than inferred client-side: the modal only
 * polls users.extension_onboarding_state. Keeping this in a lib (not the
 * route) makes the gating rules unit-testable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// States from which an extension import counts as "the first contact".
// not_started is deliberately excluded: an import made before the user ever
// opens the flow shouldn't fast-forward them into a congratulations screen
// for something they did days ago — the modal's own fast-forward handles that.
const AWAITING_FIRST_CONTACT_STATES = [
  "started",
  "awaiting_connect",
  "awaiting_first_contact",
] as const;

/**
 * Advance the flow if this import is the one a waiting step is watching for.
 * Best-effort by contract: errors are logged and swallowed — the import
 * itself must never fail because of onboarding bookkeeping.
 *
 * Uses state-filtered UPDATEs (CAS) so a concurrent import can't double-fire;
 * per rule 17, success is intentionally not read back via .select() on the
 * same query (the filter re-applies to RETURNING and yields empty rows).
 */
export async function advanceExtensionOnboarding(
  supabase: SupabaseClient,
  userId: string,
  contactId: number,
  hasEmail: boolean,
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("extension_onboarding_state")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return;
    const state = data.extension_onboarding_state as string;

    if ((AWAITING_FIRST_CONTACT_STATES as readonly string[]).includes(state)) {
      await supabase
        .from("users")
        .update({
          extension_onboarding_state: "email_offer",
          extension_onboarding_contact_id: contactId,
        })
        .eq("id", userId)
        .in("extension_onboarding_state", [...AWAITING_FIRST_CONTACT_STATES]);
    } else if (state === "awaiting_email_contact" && hasEmail) {
      await supabase
        .from("users")
        .update({ extension_onboarding_state: "done" })
        .eq("id", userId)
        .eq("extension_onboarding_state", "awaiting_email_contact");
    }
  } catch (err) {
    console.warn("[extension-onboarding] advance failed:", err);
  }
}

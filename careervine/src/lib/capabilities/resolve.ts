import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { capabilitiesFor } from "./map";
import type { Capability } from "./types";

/**
 * Resolve a user's capability set from their gmail_connections entitlement flags.
 *
 * Server-only: reads the service-role-only entitlement columns (CAR-27's
 * column-lock hides them from the browser client). Fails CLOSED — any error, or
 * no connection row, yields the empty (free) set, never a paid capability.
 * Mirrors `getApifyControls` / `resolveSharedAccess`.
 */
export async function resolveCapabilities(userId: string): Promise<Set<Capability>> {
  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("gmail_connections")
      .select("automatic_features_enabled, modify_scope_granted, premium_enabled")
      .eq("user_id", userId)
      .maybeSingle();

    if (error || !data) return new Set();

    return capabilitiesFor({
      modifyScopeGranted: data.modify_scope_granted ?? false,
      automaticFeaturesEnabled: data.automatic_features_enabled ?? false,
      // Fail OPEN to premium: a null must never silently down-tier a premium user.
      // The unconnected case is already handled by the early return above.
      premiumEnabled: data.premium_enabled ?? true,
      // Past the early return, a row exists — the positive signal for outreach:portal.
      hasConnection: true,
    });
  } catch {
    // Fail closed: never grant a capability we couldn't verify.
    return new Set();
  }
}

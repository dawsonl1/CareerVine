import type { Capability, EntitlementFlags } from "./types";

/**
 * THE single source of truth for tier -> capability logic.
 *
 * Change what a tier can do, add a tier, or grandfather a user by editing this
 * function alone — no call site anywhere else in the app knows tiers exist; they
 * only ask `can(capability)`.
 *
 * Phase 0 (CAR-103) predicates. CAR-102 refines `inbox:premium` (keys it on the
 * paid entitlement and down-scopes existing modify-holding friend accounts to
 * free) — again, a one-function edit.
 */
export function capabilitiesFor(flags: EntitlementFlags): Set<Capability> {
  const caps = new Set<Capability>();
  const { modifyScopeGranted, automaticFeaturesEnabled } = flags;

  // Scope-gated capabilities: physically require the gmail.modify scope to
  // function. A user without it never granted the scope, so these would 403.
  if (modifyScopeGranted) {
    caps.add("mailbox:read");
    caps.add("mailbox:modify");
    caps.add("drafts:gmail");
    caps.add("inbox:premium");
  }

  // Entitlement-gated: the paid automatic features. Needs BOTH the admin grant
  // AND the scope — an entitled-but-scopeless user must not be routed into the
  // live-read code path (it would 403 with the exact error the tier split avoids).
  if (automaticFeaturesEnabled && modifyScopeGranted) {
    caps.add("followups:auto");
  }

  return caps;
}

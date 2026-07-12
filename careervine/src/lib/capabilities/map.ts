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
  const { modifyScopeGranted, automaticFeaturesEnabled, premiumEnabled, hasConnection } = flags;

  // Premium (the Inbox experience) is the conjunction of a token FACT and an admin
  // SWITCH: the connection physically holds gmail.modify (modifyScopeGranted) AND the
  // admin master switch is on (premiumEnabled). Keeping them separate lets an admin
  // move a user to the free tier by turning premiumEnabled off — no reconnect, and
  // without the modifyScopeGranted fact ever lying about the token.
  const isPremium = modifyScopeGranted && premiumEnabled;

  // Scope-gated capabilities: physically require the gmail.modify scope to function.
  if (isPremium) {
    caps.add("mailbox:read");
    caps.add("mailbox:modify");
    caps.add("drafts:gmail");
    caps.add("inbox:premium");
  }

  // Automatic follow-ups: the admin opt-out flag AND premium. An enabled-but-not-
  // premium user must not be routed into the live-read code path (it would 403 with
  // the exact error the tier split avoids).
  if (automaticFeaturesEnabled && isPremium) {
    caps.add("followups:auto");
  }

  // outreach:portal (the free experience) is a POSITIVE grant: a connected user who
  // is NOT premium. A modify-less (or admin-down-scoped) connection resolves here.
  // "Free" cannot be inferred from the absence of premium alone — a modify-less user
  // otherwise resolves to an empty set — so it needs the hasConnection (row-present)
  // signal. The shell branch defaults to the Inbox and routes to Outreach ONLY on this.
  if (hasConnection && !isPremium) {
    caps.add("outreach:portal");
  }

  return caps;
}

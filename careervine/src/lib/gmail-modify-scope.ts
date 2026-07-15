/**
 * Decide whether the Gmail OAuth consent should include the restricted
 * gmail.modify scope (CAR-102 / CAR-131).
 *
 * - Preserve: already holds modify AND premium is on → keep requesting it so
 *   reconnect / calendar re-consent never silently down-scopes a premium user.
 * - Upgrade: admin turned Premium on for a free-connected account; the user
 *   clicks reconnect with `?upgrade=1` → request modify even though the token
 *   does not hold it yet.
 * - Free / admin-off: never request modify (sensitive-only consent).
 */
export function shouldRequestGmailModifyScope(opts: {
  modifyScopeGranted: boolean;
  /** null/undefined treated as enabled (legacy rows). */
  premiumEnabled: boolean | null | undefined;
  /** Explicit reconnect-to-upgrade (`?upgrade=1`). */
  upgradeRequested?: boolean;
}): boolean {
  const premiumOn = opts.premiumEnabled ?? true;
  if (!premiumOn) return false;
  return opts.modifyScopeGranted || !!opts.upgradeRequested;
}

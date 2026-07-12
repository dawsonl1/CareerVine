/**
 * CAR-103 tier capability layer — the capability vocabulary.
 *
 * Capabilities are the ONLY thing call sites gate on ("can this user read the
 * mailbox?"), never a tier ("is this user free?"). The tier -> capability
 * mapping lives in exactly one place: `capabilitiesFor()` in ./map.
 */

export type Capability =
  | "mailbox:read" // read the live Gmail mailbox (inbox/sent/trash/hidden, body-expand, labels, sync)
  | "mailbox:modify" // mailbox actions: mark-read, trash/untrash, move/label
  | "drafts:gmail" // create real Gmail drafts (drafts.create)
  | "followups:auto" // cron auto reply-detection + bounce-cancel
  | "inbox:premium" // premium tier (connection holds gmail.modify); gates mailbox operations in CAR-102
  | "outreach:portal"; // the free Outreach experience — a POSITIVE free-tier grant (nobody in Phase 0; CAR-102 grants confirmed free users)

/** The raw entitlement flags on a user's gmail_connections row — the resolver's inputs. */
export interface EntitlementFlags {
  /** Connection holds the gmail.modify scope. */
  modifyScopeGranted: boolean;
  /** Admin-granted entitlement to the paid automatic features. */
  automaticFeaturesEnabled: boolean;
}

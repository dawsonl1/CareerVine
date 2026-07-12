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
  | "inbox:premium"; // render the premium Inbox shell (else the Outreach shell)

/** The raw entitlement flags on a user's gmail_connections row — the resolver's inputs. */
export interface EntitlementFlags {
  /** Connection holds the gmail.modify scope. */
  modifyScopeGranted: boolean;
  /** Admin-granted entitlement to the paid automatic features. */
  automaticFeaturesEnabled: boolean;
}

/**
 * Shared constants for database status values and other stringly-typed fields.
 * Use these instead of raw strings to prevent typos and enable refactoring.
 */

// ── Follow-up sequence statuses ────────────────────────────────────────

export const FollowUpStatus = {
  Active: "active",
  CancelledUser: "cancelled_user",
} as const;

export const FollowUpMessageStatus = {
  Pending: "pending",
  Cancelled: "cancelled",
  Sent: "sent",
} as const;

// ── Scheduled email statuses ───────────────────────────────────────────

export const ScheduledEmailStatus = {
  Pending: "pending",
  Cancelled: "cancelled",
  CancelledUser: "cancelled_user",
  Sent: "sent",
} as const;

// ── Email direction ────────────────────────────────────────────────────

export const EmailDirection = {
  Inbound: "inbound",
  Outbound: "outbound",
} as const;

// ── Gmail labels ───────────────────────────────────────────────────────

export const GmailLabel = {
  Sent: "SENT",
  Inbox: "INBOX",
  Trash: "TRASH",
} as const;

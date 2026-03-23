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

// ── AI follow-up draft statuses ──────────────────────────────────────

export const AiFollowUpDraftStatus = {
  Pending: "pending",
  Sent: "sent",
  Dismissed: "dismissed",
  EditedAndSent: "edited_and_sent",
} as const;

// ── Gmail labels ───────────────────────────────────────────────────────

export const GmailLabel = {
  Sent: "SENT",
  Inbox: "INBOX",
  Trash: "TRASH",
} as const;

// ── Action item sources ───────────────────────────────────────────────

export const ActionItemSource = {
  Manual: "manual",
  AiSuggestion: "ai_suggestion",
  AiTranscript: "ai_transcript",
} as const;

// ── AI suggestion reason types ────────────────────────────────────────

export const SuggestionReasonType = {
  Graduation: "graduation",
  NoInteractionCadence: "no_interaction_cadence",
  DecayWarning: "decay_warning",
  FirstTouch: "first_touch",
  WaitingOnNudge: "waiting_on_nudge",
  LlmPersonalized: "llm_personalized",
  TranscriptExtracted: "transcript_extracted",
} as const;

// ── Action item direction ─────────────────────────────────────────────

export const ActionDirection = {
  MyTask: "my_task",
  WaitingOn: "waiting_on",
} as const;

// ── Meeting / conversation type options ──────────────────────────────

/** Unified type list for the conversation modal (with icon names for dynamic import) */
export const CONVERSATION_TYPE_OPTIONS = [
  { value: "coffee", label: "Coffee Chat", iconName: "Coffee" },
  { value: "phone", label: "Phone Call", iconName: "Phone" },
  { value: "video", label: "Video Call", iconName: "Video" },
  { value: "in-person", label: "In Person", iconName: "Users" },
  { value: "lunch", label: "Lunch/Dinner", iconName: "UtensilsCrossed" },
  { value: "conference", label: "Conference", iconName: "Building2" },
  { value: "networking", label: "Networking Event", iconName: "Globe" },
  { value: "other", label: "Other", iconName: "MessageSquare" },
] as const;

/** @deprecated Use CONVERSATION_TYPE_OPTIONS instead */
export const MEETING_TYPE_OPTIONS = CONVERSATION_TYPE_OPTIONS;

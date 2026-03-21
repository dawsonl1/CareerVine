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
  LlmPersonalized: "llm_personalized",
  TranscriptExtracted: "transcript_extracted",
} as const;

// ── Meeting type options (shared across meeting forms) ───────────────

export const MEETING_TYPE_OPTIONS = [
  { value: "coffee", label: "Coffee Chat" },
  { value: "phone", label: "Phone Call" },
  { value: "video", label: "Video Call" },
  { value: "in-person", label: "In Person" },
  { value: "lunch", label: "Lunch/Dinner" },
  { value: "interview", label: "Interview" },
  { value: "networking", label: "Networking Event" },
  { value: "other", label: "Other" },
] as const;

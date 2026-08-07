/**
 * Shared constants for database status values and other stringly-typed fields.
 * Use these instead of raw strings to prevent typos and enable refactoring.
 */

// ── Follow-up sequence statuses ────────────────────────────────────────

/**
 * Statuses for email_follow_ups (the parent sequence).
 *
 * All five, not the two this held until CAR-207's review. The other three were
 * raw string literals scattered across the code, and that mattered: the
 * integration conformance guard (check-constraints.itest.ts) enumerates
 * `Object.values` here, so a literal outside the enum is invisible to it. That
 * is exactly how `cancelled_bounce` reached production absent from the table's
 * CHECK, failing every bounce-driven cancel with 23514 since the table was
 * created. Add a new sequence status HERE, or the guard cannot see it.
 */
export const FollowUpStatus = {
  Active: "active",
  CancelledUser: "cancelled_user",
  CancelledReply: "cancelled_reply",
  /** Written by detectBounces when a delivery failure retires the sequence. */
  CancelledBounce: "cancelled_bounce",
  Completed: "completed",
} as const;

export const FollowUpMessageStatus = {
  Pending: "pending",
  Cancelled: "cancelled",
  Sent: "sent",
  // Transient claim held by a send driver (the send-follow-ups cron or the
  // confirm route) for the duration of one Gmail round trip — never a resting
  // state. Stamped with claimed_at (CAR-139); claims older than
  // SEND_STALE_CLAIM_MINUTES were orphaned by a crash and are swept to
  // 'failed' below (never back to 'pending', and since CAR-207 never to
  // 'awaiting_review' either — the send may have gone out, so neither an
  // automatic retry nor an invited one is safe). In the DB CHECK since
  // 20260712065000_car105_followup_nudge_expiry_columns.sql.
  Sending: "sending",
  /**
   * CAR-207: a send driver died between the Gmail send and the mark-sent write,
   * so whether the contact received this message is UNKNOWN. Terminal, and
   * deliberately absent from OPEN / UNRESOLVED / ACTIONABLE below: it holds no
   * parent sequence open, draws no nudge, and offers no "Send now".
   *
   * This is where a stale 'sending' claim lands, replacing the 'awaiting_review'
   * CAR-139 used. That was correct to refuse an automatic retry and wrong about
   * the resting state: awaiting_review renders a one-click send captioned "not
   * sent yet", so it invited the user to perform the double-send by hand.
   * Mirrors ScheduledEmailStatus.Failed, which has handled the same race since
   * CAR-134. In the DB CHECK since
   * 20260725120000_car207_followup_message_failed_status.sql.
   */
  Failed: "failed",
  // CAR-102: free-tier confirm-to-send. The cron parks a due message here instead
  // of sending; the user confirms (send) or reports a reply (cancel) from the portal.
  AwaitingReview: "awaiting_review",
  // CAR-105: the expiry window elapsed without action. NOT cancelled — stays
  // visible (greyed) and one-click sendable; the parent sequence stays 'active'.
  Expired: "expired",
} as const;

/** Follow-up message statuses that still count as an open/scheduled step: a
 * pending auto-send, or one awaiting the user's confirm-to-send (CAR-102). Used
 * for "N scheduled" counts. Expired steps are counted via UNRESOLVED instead. */
export const OPEN_FOLLOW_UP_MESSAGE_STATUSES = [
  FollowUpMessageStatus.Pending,
  FollowUpMessageStatus.AwaitingReview,
] as const;

export function isOpenFollowUpMessage(status: string | null | undefined): boolean {
  return status === FollowUpMessageStatus.Pending || status === FollowUpMessageStatus.AwaitingReview;
}

/** Follow-up message statuses that keep the PARENT sequence open and must be
 * cleared on teardown OR rebuilt on edit: the open steps PLUS 'expired'. An
 * expired message is still one-click sendable, so a sequence isn't "complete"
 * while one lingers, and cancel/reply/edit must clear it too (CAR-105, CAR-125). */
export const UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES = [
  FollowUpMessageStatus.Pending,
  FollowUpMessageStatus.AwaitingReview,
  FollowUpMessageStatus.Expired,
] as const;

export function isUnresolvedFollowUpMessage(status: string | null | undefined): boolean {
  return (
    status === FollowUpMessageStatus.Pending ||
    status === FollowUpMessageStatus.AwaitingReview ||
    status === FollowUpMessageStatus.Expired
  );
}

/** Follow-up message statuses the user can still ACT on from the portal or a
 * contact page (confirm-send or mark-replied): freshly parked (awaiting_review)
 * or softly retired but still one-click sendable (expired). Drives the free-tier
 * nav badge, the confirm route's guard/claim, and the Send now / They replied
 * buttons. DISTINCT from OPEN (adds pending auto-sends the user never manually
 * actions) and UNRESOLVED (adds pending, for teardown). CAR-105. */
export const ACTIONABLE_FOLLOW_UP_MESSAGE_STATUSES = [
  FollowUpMessageStatus.AwaitingReview,
  FollowUpMessageStatus.Expired,
] as const;

export function isActionableFollowUpMessage(status: string | null | undefined): boolean {
  return status === FollowUpMessageStatus.AwaitingReview || status === FollowUpMessageStatus.Expired;
}

// ── Scheduled email statuses ───────────────────────────────────────────

/** Statuses for scheduled_emails. The DB CHECK allows exactly these five
 * (pending/sending/sent/cancelled/failed; 'sending' + 'failed' added by CAR-134).
 * There is no 'cancelled_user' here (that's email_follow_ups vocabulary; a
 * stray CancelledUser entry in this enum led db.ts to write it, and every MCP
 * scheduled-email cancel failed on the CHECK until CAR-132). */
export const ScheduledEmailStatus = {
  Pending: "pending",
  /** Claimed by a send driver (CAR-134) — transient, hidden from list UIs. */
  Sending: "sending",
  Cancelled: "cancelled",
  Sent: "sent",
  /** Claim went stale (process died mid-send). Surfaced with a Retry action,
   * never auto-retried: the send may or may not have gone out. */
  Failed: "failed",
} as const;

/** Claims in 'sending' older than this are dead (no lambda runs this long).
 * Both crons sweep them to 'failed': scheduled_emails since CAR-134,
 * email_follow_up_messages since CAR-207 (which replaced CAR-139's
 * 'awaiting_review' — see FollowUpMessageStatus.Failed for why). */
export const SEND_STALE_CLAIM_MINUTES = 15;

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

// ── Contact change events (plan 29) ───────────────────────────────────

export const ChangeEventType = {
  Anniversary: "anniversary",
  CompanyChange: "company_change",
  Promotion: "promotion",
  Hiring: "hiring",
  OpenToWork: "open_to_work",
  Certification: "certification",
  LocationChange: "location_change",
} as const;

export const ChangeEventStatus = {
  New: "new",
  Actioned: "actioned",
  Dismissed: "dismissed",
  Snoozed: "snoozed",
} as const;

export const ChangeEventTier = {
  ActNow: 1,
  Touchpoint: 2,
  Silent: 3,
} as const;

// ── Apify scrape runs (plan 29) ───────────────────────────────────────

export const ScrapeRunStatus = {
  Pending: "pending",
  Succeeded: "succeeded",
  Failed: "failed",
  TimedOut: "timed_out",
} as const;

export const ScrapeMode = {
  /** Profile details only — $0.004/profile */
  Profile: "profile",
  /** Profile details + SMTP-verified email search — $0.01/profile */
  Email: "email",
  /** Discovery people-search page — $0.10/page, ≤25 short profiles (plan 41) */
  Discovery: "discovery",
} as const;

export const ScrapeTrigger = {
  Manual: "manual",
  EnrichOnSave: "enrich_on_save",
  Cadence: "cadence",
  Discovery: "discovery",
} as const;

/** The Apify actor used for all in-app scrapes (plan 29 §2). */
export const PROFILE_SCRAPER_ACTOR = "harvestapi/linkedin-profile-scraper";

/** Actor B — the name→profile fallback resolver (plan 29 §2). */
export const PROFILE_SEARCH_BY_NAME_ACTOR = "harvestapi/linkedin-profile-search-by-name";

/** One short-mode search page ($4/1k pages, ≤10 short profiles). */
export const RESOLVE_COST_USD = 0.004;

/** Consecutive scrape failures before the UI suggests re-linking the profile. */
export const SCRAPE_FAILURES_BEFORE_RELINK = 3;

/** Per-profile Apify cost at BRONZE tier, used for pre-run budget checks. */
export const SCRAPE_UNIT_COST_USD = { profile: 0.004, email: 0.01 } as const;

/** Hard monthly Apify spend cap (Dawson's decision, plan 29 §9). */
export const MONTHLY_SCRAPE_CAP_USD = 10;

/**
 * Soft cap for AUTOMATIC spend (plan 29 §9.3 graceful degradation): the
 * cadence drip stops here so manual refresh / find-email / resolve keep the
 * remaining headroom up to the hard cap.
 */
export const CADENCE_SOFT_CAP_USD = 8;

/** Debounce: skip a manual re-scrape if the contact was scraped this recently. */
export const SCRAPE_DEBOUNCE_DAYS = 7;

/**
 * Cadence freshness floor: the daily drip never re-scrapes a contact whose
 * last successful scrape is younger than this. Keeps a small fleet from
 * burning the cap on redundant daily re-scrapes (deep-review 3, finding J):
 * without it, 60 contacts × $0.004 × 30 days ≈ $7.20/mo of pure noise.
 */
export const CADENCE_MIN_AGE_DAYS = 14;

/**
 * Daily cadence drip size (plan 29 §7.3): ~80/day covers a ~2,000-contact
 * fleet monthly plus headroom (the deep review corrected the original 25).
 */
export const DAILY_CADENCE_TARGET = 80;

/** Contacts per cadence Apify run — sized so webhook ingest fits maxDuration. */
export const CADENCE_BATCH_SIZE = 25;

// ── Discovery feed (plan 41, CAR-29) ─────────────────────────────────

/** Actor C — the filter-based people search powering the discovery feed. */
export const PROFILE_SEARCH_ACTOR = "harvestapi/linkedin-profile-search";

/** One discovery search page ($0.10 at BRONZE, ≤25 short profiles). */
export const DISCOVERY_PAGE_COST_USD = 0.1;

/**
 * Soft monthly cap for discovery spend — its own lane so the weekly search
 * can never eat the cadence drip's budget (and vice versa). The $10 global
 * hard cap still applies on top.
 */
export const DISCOVERY_SOFT_CAP_USD = 2;

/** Target companies queried per weekly discovery cron run. */
export const DISCOVERY_COMPANIES_PER_RUN = 5;

/**
 * Per-company re-query floor. The actor's recentlyChangedJobs window is 90
 * days, so a ~monthly revisit misses nobody; 30 days keeps the rotation
 * cheap while the cron cycles through the whole eligible target list.
 */
export const DISCOVERY_MIN_AGE_DAYS = 30;

/** LinkedIn function id for Product Management (verified actor enum). */
export const DISCOVERY_FUNCTION_IDS = ["19"];

// ── Action item direction ─────────────────────────────────────────────

export const ActionDirection = {
  MyTask: "my_task",
  WaitingOn: "waiting_on",
} as const;

// ── Meeting / conversation type options ──────────────────────────────

/**
 * The single vocabulary for a logged conversation (CAR-242). ONE list drives
 * `meetings.meeting_type`, `interactions.interaction_type`, and the MCP
 * `log_interaction` enum — before CAR-242 those were three disjoint lists
 * agreeing on only `coffee` and `other`.
 *
 * `Coffee` is the 1:1-conversation bucket REGARDLESS OF MEDIUM: phone and video
 * calls belong here, which is why neither is its own value. That is not obvious
 * from the label, so every picker renders CONVERSATION_TYPE_HINT alongside it.
 *
 * Both columns carry a CHECK over exactly these values (plus the system-only
 * `email` on interactions), enumerated for the conformance guard as
 * CONVERSATION_TYPE_VALUES / INTERACTION_TYPE_VALUES below. Adding a value HERE
 * without adding it to the CHECK is the CAR-132 failure mode: every write of it
 * fails with 23514. Add it in a migration too.
 */
export const ConversationType = {
  CareerFair: "career-fair",
  Networking: "networking",
  /** Includes phone and video calls — see the note above. */
  Coffee: "coffee",
  Text: "text",
  /** The only value that may carry a `*_type_detail` free-text string. */
  Other: "other",
} as const;

export type ConversationTypeValue = (typeof ConversationType)[keyof typeof ConversationType];

/** Unified type list for every conversation picker (icon names for dynamic import) */
export const CONVERSATION_TYPE_OPTIONS = [
  { value: ConversationType.CareerFair, label: "Career Fair", iconName: "Briefcase" },
  { value: ConversationType.Networking, label: "Networking Event", iconName: "Users" },
  { value: ConversationType.Coffee, label: "Coffee Chat", iconName: "Coffee" },
  { value: ConversationType.Text, label: "Text Message Chat", iconName: "MessageSquare" },
  { value: ConversationType.Other, label: "Other", iconName: "CircleEllipsis" },
] as const;

/** Shown under every type picker. Without it, a user logging a phone call
 * reaches for Other and defeats the consolidation. */
export const CONVERSATION_TYPE_HINT = "Coffee Chat covers any one-on-one conversation, including phone and video calls.";

/** A readonly TUPLE, not `Object.values(...)`: this feeds `z.enum()` in the MCP
 * `log_interaction` tool directly, so the tool's accepted values cannot drift
 * from this list the way the old hardcoded enum did. */
export const CONVERSATION_TYPE_VALUES = [
  ConversationType.CareerFair,
  ConversationType.Networking,
  ConversationType.Coffee,
  ConversationType.Text,
  ConversationType.Other,
] as const;

/**
 * Written by the email send path (`email-send.ts`) and bulk import — NEVER
 * user-selectable, so it is absent from CONVERSATION_TYPE_OPTIONS while still
 * being a legal `interactions.interaction_type`. All 70 production interactions
 * carried this value at the time of CAR-242.
 */
export const SYSTEM_INTERACTION_TYPE_EMAIL = "email";

/** The full `interactions.interaction_type` CHECK vocabulary: the user-selectable
 * five plus the system-only `email`. */
export const INTERACTION_TYPE_VALUES = [
  ...CONVERSATION_TYPE_VALUES,
  SYSTEM_INTERACTION_TYPE_EMAIL,
] as const;

/** Mirrors the `char_length(...) BETWEEN 1 AND 80` half of the detail CHECK.
 * Kept in sync by check-constraints.itest.ts's write-path assertions. */
export const CONVERSATION_TYPE_DETAIL_MAX_LENGTH = 80;

/**
 * Normalizes a type/detail pair to what the DB will accept: the detail is
 * dropped unless the type is `other`, and blank detail collapses to null. Use
 * this at EVERY write site — the `*_type_detail` CHECK rejects a detail carried
 * over from a type the user has since switched away from.
 */
export function normalizeConversationTypeDetail(
  type: string | null,
  detail: string | null | undefined,
): string | null {
  if (type !== ConversationType.Other) return null;
  const trimmed = (detail ?? "").trim();
  return trimmed ? trimmed.slice(0, CONVERSATION_TYPE_DETAIL_MAX_LENGTH) : null;
}

/**
 * The display string for a stored type/detail pair. Use this EVERYWHERE a type
 * is rendered instead of the CSS `capitalize` these call sites used before
 * CAR-242 — `capitalize` turns `career-fair` into "Career-fair" and cannot show
 * the user's own words for Other.
 *
 * Returns null for an absent type so callers keep their own fallback ("Meeting").
 */
export function conversationTypeLabel(
  type: string | null | undefined,
  detail?: string | null,
): string | null {
  if (!type) return null;
  if (type === ConversationType.Other) {
    const trimmed = detail?.trim();
    if (trimmed) return trimmed;
  }
  const option = CONVERSATION_TYPE_OPTIONS.find((o) => o.value === type);
  if (option) return option.label;
  if (type === SYSTEM_INTERACTION_TYPE_EMAIL) return "Email";
  // A value predating CAR-242's backfill, or written by a client that has not
  // reloaded. The CHECK makes new ones impossible; humanize rather than 404.
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/[-_]/g, " ");
}

// ── Home page constants ──────────────────────────────────────────────

// ── Calendar RSVP display ────────────────────────────────────────────

const RSVP_DISPLAY: Record<string, { className: string; label: string }> = {
  accepted: { className: "text-primary", label: "✓" },
  declined: { className: "text-destructive", label: "✗" },
  tentative: { className: "text-tertiary", label: "?" },
  needsAction: { className: "text-muted-foreground", label: "–" },
};

const RSVP_DEFAULT = { className: "text-muted-foreground", label: "–" };

export function getRsvpDisplay(
  // Accepts undefined (CAR-191 review): `attendees.responseStatus` is optional on
  // the shared `CalendarAttendee`, and this already falls back for an unknown
  // value, so refusing an absent one only pushed the guard to every call site.
  status: string | undefined,
): { className: string; label: string } {
  return (status ? RSVP_DISPLAY[status] : undefined) ?? RSVP_DEFAULT;
}

/** Contacts added within this many days appear in "Recently Added" */
export const RECENTLY_ADDED_DAYS = 7;

/** Days to suppress a contact from AI suggestions after snooze/dismiss */
export const SUGGESTION_COOLDOWN_DAYS = 21;

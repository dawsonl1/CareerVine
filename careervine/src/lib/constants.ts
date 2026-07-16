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

export const ScheduledEmailStatus = {
  Pending: "pending",
  /** Claimed by a send driver (CAR-134) — transient, hidden from list UIs. */
  Sending: "sending",
  Cancelled: "cancelled",
  CancelledUser: "cancelled_user",
  Sent: "sent",
  /** Claim went stale (process died mid-send). Surfaced with a Retry action,
   * never auto-retried: the send may or may not have gone out. */
  Failed: "failed",
} as const;

/** Claims in 'sending' older than this are dead (no lambda runs this long)
 * and get swept to 'failed' by the cron. */
export const SCHEDULED_SEND_STALE_CLAIM_MINUTES = 15;

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

// ── Home page constants ──────────────────────────────────────────────

// ── Calendar RSVP display ────────────────────────────────────────────

const RSVP_DISPLAY: Record<string, { className: string; label: string }> = {
  accepted: { className: "text-primary", label: "✓" },
  declined: { className: "text-destructive", label: "✗" },
  tentative: { className: "text-tertiary", label: "?" },
  needsAction: { className: "text-muted-foreground", label: "–" },
};

const RSVP_DEFAULT = { className: "text-muted-foreground", label: "–" };

export function getRsvpDisplay(status: string): { className: string; label: string } {
  return RSVP_DISPLAY[status] ?? RSVP_DEFAULT;
}

/** Contacts added within this many days appear in "Recently Added" */
export const RECENTLY_ADDED_DAYS = 7;

/** Days to suppress a contact from AI suggestions after snooze/dismiss */
export const SUGGESTION_COOLDOWN_DAYS = 21;

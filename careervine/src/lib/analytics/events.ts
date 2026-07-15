/**
 * The product-analytics event registry — the single vocabulary shared by every
 * surface (web client, API routes, MCP server, Chrome extension).
 *
 * Rules of the registry (CAR-38):
 * - Deliberately small: an event earns its place by answering a PM question
 *   (activation, outreach-loop health, feature adoption, AI acceptance,
 *   guardrails) — not by existing because a button exists.
 * - Names are `object_verb`, past tense.
 * - Never call PostHog directly from features; go through `track()` (client)
 *   or `trackServer()` so the vendor stays swappable.
 */

/** Where the event was emitted from. Carried on every event as `surface`. */
export type Surface = "web" | "server" | "extension" | "mcp";

/**
 * New-user value milestones (Dawson's onboarding metric list, CAR-38).
 * Each is reached at most once per user; `user_milestones` guarantees that.
 * Time-to-milestone funnels read: extension_installed → extension_logged_in
 * → contacts_5 → companies_emailed_5, with bundle_subscribed alongside.
 */
export type Milestone = "contacts_5" | "companies_emailed_5";

export const MILESTONE_THRESHOLDS = {
  contacts_5: 5,
  companies_emailed_5: 5,
} as const satisfies Record<Milestone, number>;

/**
 * Event name → property payload. Adding an event here is the only step needed
 * for it to be trackable from any surface.
 */
export type AnalyticsEvents = {
  // ── Lifecycle / activation funnel ─────────────────────────────────
  user_signed_up: Record<string, never>;
  /** Confirmation link clicked and verified server-side (/auth/confirm). */
  user_email_verified: Record<string, never>;
  gmail_connected: Record<string, never>;
  gmail_disconnected: Record<string, never>;
  calendar_connected: Record<string, never>;
  calendar_disconnected: Record<string, never>;

  // ── Contacts loop ─────────────────────────────────────────────────
  contact_imported: {
    source: "extension" | "bulk" | "manual" | "bundle" | "mcp" | "discovery";
    count?: number;
    /** Bundle syncs only (CAR-78): true when the CAR-62 fast path did the
     * import. Absent on non-bundle sources. */
    fast?: boolean;
  };
  // (contact/page views come free from $pageview + autocapture — no
  // curated event needed.)

  // ── Data quality ──────────────────────────────────────────────────
  /** An identity-less company import created a row whose name resembles an
   * existing company — the split-row pattern behind CAR-44. */
  company_duplicate_suspected: {
    company: string;
    possible_duplicate: string;
  };

  // ── Outreach loop (the core loop) ─────────────────────────────────
  email_sent: {
    is_follow_up?: boolean;
    is_scheduled?: boolean;
    ai_assisted?: boolean;
  };
  email_scheduled: { send_in_hours?: number };
  follow_up_sequence_created: { steps?: number };
  /**
   * North-star outcome. Thread-attributed: only emitted when Gmail sync ties
   * the inbound message to an outreach thread we sent (threadId match) —
   * unrelated inbound must NOT emit this, or reply rate stops meaning
   * "outreach that worked".
   */
  reply_received: { ai_assisted?: boolean };
  meeting_created: Record<string, never>;

  // ── AI features ───────────────────────────────────────────────────
  ai_draft_generated: {
    kind: "intro" | "follow_up" | "write";
    latency_ms?: number;
  };
  /**
   * Acceptance-rate trio for any AI-generated draft. `edit_ratio` is the
   * share of the generated draft that survived to send (1 = sent verbatim,
   * 0 = fully rewritten) — distinguishes "tweaked greeting" from "rewrote
   * everything". Only present for sent/edited outcomes. `kind` mirrors
   * ai_draft_generated so per-surface acceptance rates are computable
   * (CAR-58 audit: outcomes were kindless, so intro/write/follow_up
   * acceptance couldn't be separated).
   */
  ai_draft_outcome: {
    outcome: "sent" | "edited" | "discarded";
    edit_ratio?: number;
    kind?: "intro" | "follow_up" | "write";
  };
  transcript_processed: { step: "transcribe" | "parse" | "extract_actions" };
  /**
   * 24h shared-AI trial lifecycle (CAR-51). Started fires once when the trial
   * row is created at first AI use; expired fires once on the lazy post-expiry
   * flip; requested fires when the user asks for continued access.
   */
  ai_trial_started: Record<string, never>;
  ai_trial_expired: Record<string, never>;
  ai_access_requested: Record<string, never>;

  // ── Bundles (data subscriptions) ──────────────────────────────────
  bundle_subscribed: { bundle_id?: string };
  bundle_unsubscribed: { bundle_id?: string };

  // ── Guided onboarding funnel (CAR-50) ─────────────────────────────
  /** First-run intro opened for a brand-new account. */
  onboarding_started: Record<string, never>;
  onboarding_bundle_accepted: Record<string, never>;
  onboarding_bundle_declined: Record<string, never>;
  /** Left the dedicated connect step toward the company picker (CAR-82). */
  onboarding_connect_advanced: Record<string, never>;
  onboarding_sync_completed: {
    prospects?: number;
    /** Which server path applied the sync (CAR-78 instrumentation). Absent
     * when a background driver finished it and the client never saw a step. */
    path?: "fast" | "merge";
    duration_ms?: number;
  };
  onboarding_company_picked: { alumni_count?: number };
  /** Activation: the guided flow's first outreach email went out. */
  onboarding_email_sent: Record<string, never>;
  onboarding_completed: Record<string, never>;
  onboarding_skipped: { at_step: string };

  // ── Extension onboarding funnel (CAR-68) ─────────────────────────
  /** "Start (est. 3 min)" clicked on the seeded home-page to-do. */
  extension_onboarding_started: Record<string, never>;
  /** A flow step advanced client-side; state is the step just entered. */
  extension_onboarding_step: { state: string };
  /** The seeded to-do was deleted from the flow's intro step. */
  extension_onboarding_deleted: Record<string, never>;
  /** Terminal state reached; apollo=false is the "see my contact" exit. */
  extension_onboarding_completed: { apollo: boolean };

  // ── Settings ──────────────────────────────────────────────────────
  api_key_saved: { provider: "openai" | "deepgram" };

  // ── New-user milestones (one-time per user, backed by user_milestones) ──
  /** Emitted once, server-side, the first time the threshold is crossed. */
  milestone_reached: { milestone: Milestone };

  // ── Cross-surface usage ───────────────────────────────────────────
  mcp_tool_called: { tool: string; success: boolean; duration_ms: number };
  /** Fired anonymously from chrome.runtime.onInstalled; merged on login. */
  extension_installed: Record<string, never>;
  extension_logged_in: Record<string, never>;
  profile_scraped: Record<string, never>;

  // ── Client-only intent events ─────────────────────────────────────
  compose_opened: { source?: string };
  quick_capture_used: Record<string, never>;
  /**
   * Connect-CTA clicks (CAR-58). Paired with the server-side
   * gmail_connected/calendar_connected success events, these make Google
   * consent-screen abandonment measurable — without them a click that goes
   * nowhere is indistinguishable from never trying.
   */
  gmail_connect_clicked: { source: "setup_banner" | "settings" | "inbox" | "outreach" };
  calendar_connect_clicked: { source: "setup_banner" | "settings" };

  // ── Free-tier follow-up nudges (CAR-105) ─────────────────────────
  /**
   * A reminder digest email went out to a free-tier user with follow-ups
   * parked awaiting review. `items` is how many the digest covered — the
   * signal for "are the nudges doing their job" (open/act rate follows from
   * the portal visits + confirms they drive).
   */
  nudge_sent: { items: number };
  /**
   * A parked follow-up crossed its active-aware expiry window and flipped to
   * `expired`. Volume here is the free-tier friction signal: items the user
   * left unconfirmed long enough to go stale (still recoverable, never lost).
   */
  follow_up_expired: Record<string, never>;

  // ── Guardrails ────────────────────────────────────────────────────
  send_cap_hit: Record<string, never>;
  api_error: { route: string; method: string };
};

export type AnalyticsEvent = keyof AnalyticsEvents;

/**
 * Business-critical outcome events also written to the first-party
 * `analytics_events` Supabase table, so outcome data lives next to domain
 * data and survives any analytics-vendor change.
 */
export const MIRRORED_EVENTS: readonly AnalyticsEvent[] = [
  "email_sent",
  "reply_received",
  "meeting_created",
] as const;

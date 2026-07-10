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
  gmail_connected: Record<string, never>;
  gmail_disconnected: Record<string, never>;
  calendar_connected: Record<string, never>;
  calendar_disconnected: Record<string, never>;

  // ── Contacts loop ─────────────────────────────────────────────────
  contact_imported: {
    source: "extension" | "bulk" | "manual" | "bundle";
    count?: number;
  };
  // (contact/page views come free from $pageview + autocapture — no
  // curated event needed.)

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
    kind: "intro" | "follow_up" | "write" | "suggestion";
    latency_ms?: number;
  };
  /**
   * Acceptance-rate trio for any AI-generated draft. `edit_ratio` is the
   * share of the generated draft that survived to send (1 = sent verbatim,
   * 0 = fully rewritten) — distinguishes "tweaked greeting" from "rewrote
   * everything". Only present for sent/edited outcomes.
   */
  ai_draft_outcome: {
    outcome: "sent" | "edited" | "discarded";
    edit_ratio?: number;
  };
  transcript_processed: { step: "transcribe" | "parse" | "extract_actions" };

  // ── Bundles (data subscriptions) ──────────────────────────────────
  bundle_subscribed: { bundle_id?: string };
  bundle_unsubscribed: { bundle_id?: string };

  // ── Guided onboarding funnel (CAR-50) ─────────────────────────────
  /** First-run intro opened for a brand-new account. */
  onboarding_started: Record<string, never>;
  onboarding_bundle_accepted: Record<string, never>;
  onboarding_bundle_declined: Record<string, never>;
  onboarding_sync_completed: { prospects?: number };
  onboarding_company_picked: { alumni_count?: number };
  /** Activation: the guided flow's first outreach email went out. */
  onboarding_email_sent: Record<string, never>;
  onboarding_completed: Record<string, never>;
  onboarding_skipped: { at_step: string };

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

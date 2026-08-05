"use client";

/**
 * Client-side analytics helpers: PostHog init + the typed track() functions
 * components use. The React <AnalyticsProvider> that binds identity to the
 * Supabase session lives in @/components/analytics-provider — it needs useAuth,
 * and src/lib must point strictly downward (CAR-140 / F55), never back up into
 * components. Both share this module's posthog singleton + ensureInit(), so
 * init still happens exactly once.
 *
 * - Autocapture ON (CAR-38 decision): raw clicks are a retroactive safety
 *   net; dashboards are built only on the curated events in events.ts.
 * - Session replay ON with all inputs masked and any element marked
 *   data-ph-mask redacted — email bodies and contact PII stay out of
 *   recordings. It STARTS after load rather than at init (CAR-229); see
 *   scheduleSessionRecording below.
 * - Identity is the Supabase user id, same as every other surface.
 * - No-ops without NEXT_PUBLIC_POSTHOG_KEY.
 */

import posthog from "posthog-js";
import type { AnalyticsEvent, AnalyticsEvents } from "./events";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/**
 * Upper bound on how long the idle wait may defer the recorder. Without it a
 * permanently busy tab would never record at all.
 */
const RECORDER_IDLE_TIMEOUT_MS = 5000;

let initialized = false;
let recordingScheduled = false;

/**
 * Turn session replay on once the page has loaded and gone idle.
 *
 * posthog.init with `disable_session_recording: true` skips fetching the rrweb
 * recorder, which is a separate script pulled from the PostHog host and is the
 * single largest thing analytics put on the first-paint path (CAR-229).
 * startSessionRecording() flips that config back to false and loads it, so
 * deferring the call moves the whole cost past first paint without changing
 * what ends up recorded — the masking rules are set at init and apply the
 * moment recording begins.
 *
 * The opt-out check mirrors AnalyticsProvider, which opts internal accounts out
 * as soon as the Supabase session resolves: if that has already happened by the
 * time we go idle, never resurrect recording for them.
 */
function scheduleSessionRecording(): void {
  if (recordingScheduled || typeof window === "undefined") return;
  recordingScheduled = true;

  const start = () => {
    if (posthog.has_opted_out_capturing()) return;
    posthog.startSessionRecording();
  };

  const whenIdle = () => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(start, { timeout: RECORDER_IDLE_TIMEOUT_MS });
    } else {
      // Safari below 16.4 has no requestIdleCallback; a macrotask still lands
      // after the load handlers, which is the part that matters.
      window.setTimeout(start, 0);
    }
  };

  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
}

/** Idempotent PostHog init; returns false (disabled) without a key or window. */
export function ensureInit(): boolean {
  if (initialized) return true;
  if (!POSTHOG_KEY || typeof window === "undefined") return false;
  posthog.init(POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    // 2025+ defaults: history-change pageviews (App Router navigation),
    // pageleave, sane cookie behavior.
    defaults: "2025-05-24",
    // Only create person profiles for signed-in users; anonymous marketing
    // traffic stays cheap and out of the way.
    person_profiles: "identified_only",
    autocapture: true,
    // Off at init, on at idle — scheduleSessionRecording() owns the handoff.
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
    },
  });
  initialized = true;
  scheduleSessionRecording();
  return true;
}

/** Typed client-side capture. Safe to call anywhere; no-ops when disabled. */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...args: AnalyticsEvents[E] extends Record<string, never>
    ? [] | [AnalyticsEvents[E]]
    : [AnalyticsEvents[E]]
): void {
  if (!ensureInit()) return;
  posthog.capture(event, { ...(args[0] ?? {}), surface: "web" });
}

/**
 * Like track(), but delivered via sendBeacon so the event survives an
 * immediate full-page navigation (e.g. the Connect Gmail CTAs, which are
 * plain <a> links straight into the Google OAuth redirect).
 */
export function trackBeforeNavigate<E extends AnalyticsEvent>(
  event: E,
  ...args: AnalyticsEvents[E] extends Record<string, never>
    ? [] | [AnalyticsEvents[E]]
    : [AnalyticsEvents[E]]
): void {
  if (!ensureInit()) return;
  posthog.capture(
    event,
    { ...(args[0] ?? {}), surface: "web" },
    { transport: "sendBeacon" },
  );
}

/**
 * Bind the PostHog person to a just-created account (CAR-58 audit). Supabase
 * returns the new user's id even while the account is unconfirmed, and
 * identifying BEFORE user_signed_up fires attaches the event to the real
 * person — so a later login by a *different* user in this browser can't
 * inherit the signup via anon-id aliasing, and confirming the email on
 * another device still lands on the same person.
 */
export function identifyNewUser(userId: string, email?: string | null): void {
  if (!ensureInit()) return;
  posthog.identify(userId, email ? { email } : undefined);
}

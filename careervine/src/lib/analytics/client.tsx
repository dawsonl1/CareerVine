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
 *   recordings.
 * - Identity is the Supabase user id, same as every other surface.
 * - No-ops without NEXT_PUBLIC_POSTHOG_KEY.
 */

import posthog from "posthog-js";
import type { AnalyticsEvent, AnalyticsEvents } from "./events";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

let initialized = false;

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
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
    },
  });
  initialized = true;
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

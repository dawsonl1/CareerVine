"use client";

/**
 * Client-side analytics: PostHog provider + the typed track() components use.
 *
 * - Autocapture ON (CAR-38 decision): raw clicks are a retroactive safety
 *   net; dashboards are built only on the curated events in events.ts.
 * - Session replay ON with all inputs masked and any element marked
 *   data-ph-mask redacted — email bodies and contact PII stay out of
 *   recordings.
 * - Identity is the Supabase user id, same as every other surface.
 * - No-ops without NEXT_PUBLIC_POSTHOG_KEY.
 */

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useAuth } from "@/components/auth-provider";
import { isInternalUser } from "./internal";
import type { AnalyticsEvent, AnalyticsEvents } from "./events";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

let initialized = false;

function ensureInit(): boolean {
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

/**
 * Wraps the app (inside AuthProvider). Ties the PostHog person to the
 * Supabase user id on sign-in and severs it on sign-out so a shared browser
 * can't attribute one user's events to another.
 */
export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const enabled = ensureInit();

  useEffect(() => {
    if (!enabled || loading) return;
    if (user) {
      // Internal accounts (Dawson/test users) produce no analytics at all —
      // opt-out kills curated events, autocapture, pageviews, and session
      // replay in one switch (CAR-60). Re-opt-in when a real user signs in
      // on the same device, since opt-out persists in browser storage.
      if (isInternalUser(user.id)) {
        posthog.opt_out_capturing();
        return;
      }
      if (posthog.has_opted_out_capturing()) {
        posthog.opt_in_capturing();
      }
      if (posthog.get_distinct_id() !== user.id) {
        posthog.identify(user.id, { email: user.email });
      }
    } else if (posthog.get_property("$user_id")) {
      // Was identified, now signed out — sever the device from the person so
      // a shared browser can't attribute the next user's events to this one.
      posthog.reset();
    }
  }, [enabled, loading, user]);

  if (!enabled) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}

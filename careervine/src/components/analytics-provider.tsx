"use client";

/**
 * PostHog React provider that binds analytics identity to the Supabase session.
 * Lives in src/components (not src/lib) because it depends on useAuth — keeping
 * the dependency arrow pointing down from components → lib (CAR-140 / F55). The
 * pure track()/ensureInit() helpers stay in @/lib/analytics/client and share
 * the same posthog singleton, so init still happens exactly once.
 */

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useAuth } from "@/components/auth-provider";
import { ensureInit } from "@/lib/analytics/client";

/**
 * Wraps the app (inside AuthProvider). Ties the PostHog person to the Supabase
 * user id on sign-in and severs it on sign-out so a shared browser can't
 * attribute one user's events to another.
 */
export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const enabled = ensureInit();

  useEffect(() => {
    if (!enabled || loading) return;
    if (user) {
      // Internal accounts (Dawson/test users) produce no analytics at all —
      // opt-out kills curated events, autocapture, pageviews, and session
      // replay in one switch (CAR-60/CAR-80). The is_internal flag is an
      // email-derived JWT claim (app_metadata) set at signup, so it survives
      // account delete/recreate. Re-opt-in when a real user signs in on the
      // same device, since opt-out persists in browser storage.
      if (user.app_metadata?.is_internal === true) {
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

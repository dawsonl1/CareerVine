import { NextResponse } from "next/server";
import crypto from "crypto";
import { getAuthUrl } from "@/lib/gmail";
import { withApiHandler } from "@/lib/api-handler";
import { gmailAuthQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/auth?scopes=calendar
 * Generates a Google OAuth consent URL and redirects the user to it.
 * Uses a random nonce + user ID + timestamp for CSRF protection.
 * Optional query param: scopes=calendar to include Calendar scopes
 */
export const GET = withApiHandler({
  querySchema: gmailAuthQuerySchema,
  handler: async ({ user, query, request }) => {
    const includeCalendar = query.scopes === "calendar";

    // Preserve the restricted gmail.modify scope for users who are ALREADY premium
    // (modify_scope_granted && premium_enabled). Otherwise a premium user clicking
    // "Connect Calendar" or reconnecting would re-consent without modify and get
    // silently downgraded to the free tier. New / free users get sensitive-only, so
    // the default consent screen stays sensitive-only for verification (CAR-102).
    //
    // Read the raw entitlement flags directly rather than via resolveCapabilities():
    // that helper fails CLOSED to an empty set on a DB error — the right call for
    // GATING access, but the wrong call for deciding which scopes to request here,
    // where failing closed would silently drop modify and downgrade a premium user
    // on a transient blip. So on a read error we ABORT the connect instead of
    // proceeding scope-light; the user can retry.
    const service = createSupabaseServiceClient();
    const { data: conn, error } = await service
      .from("gmail_connections")
      .select("modify_scope_granted, premium_enabled")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      const baseUrl = new URL(request.url).origin;
      return NextResponse.redirect(
        `${baseUrl}/settings?gmail=error&reason=${encodeURIComponent(
          "Could not verify your account. Please try again",
        )}`,
      );
    }

    // Mirrors capabilitiesFor's isPremium: modify granted AND premium not disabled.
    // A new user (no row yet) resolves to false -> sensitive-only consent.
    const includeModify =
      (conn?.modify_scope_granted ?? false) && (conn?.premium_enabled ?? true);

    // Optional post-OAuth landing path (CAR-50 onboarding). Only same-origin
    // relative paths ride along in state; anything else falls back to
    // /settings in the callback. "//host" would be protocol-relative — reject.
    const returnTo =
      query.returnTo && query.returnTo.startsWith("/") && !query.returnTo.startsWith("//")
        ? query.returnTo
        : undefined;

    // Build CSRF-safe state: random nonce + user ID + timestamp
    const nonce = crypto.randomBytes(16).toString("hex");
    const state = Buffer.from(JSON.stringify({
      userId: user.id,
      nonce,
      ts: Date.now(),
      ...(returnTo ? { returnTo } : {}),
    })).toString("base64url");

    const url = getAuthUrl(state, { includeCalendar, includeModify });
    return NextResponse.redirect(url);
  },
});

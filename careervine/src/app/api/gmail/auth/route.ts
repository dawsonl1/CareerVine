import { NextResponse } from "next/server";
import crypto from "crypto";
import { getAuthUrl } from "@/lib/gmail";
import { withApiHandler } from "@/lib/api-handler";
import { gmailAuthQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { shouldRequestGmailModifyScope } from "@/lib/gmail-modify-scope";

/**
 * GET /api/gmail/auth
 * Generates a Google OAuth consent URL and redirects the user to it.
 * Uses a random nonce + user ID + timestamp for CSRF protection.
 */
export const GET = withApiHandler({
  querySchema: gmailAuthQuerySchema,
  handler: async ({ user, query, request }) => {
    // CAR-100: Gmail and Calendar are always requested together, so the user
    // passes through Google's consent screen (and the "unverified app" warning)
    // once, not twice. Both are sensitive scopes, so bundling them changes
    // nothing about verification or CASA — only the paid gmail.modify scope
    // (added conditionally below) is restricted.
    const includeCalendar = true;

    // Scope decision (CAR-102 / CAR-131):
    // - Preserve modify for users who already hold it and still have Premium on.
    // - Upgrade path: ?upgrade=1 + premium on → request modify even if not granted yet.
    // - Free / Premium-off: sensitive-only so the default consent stays verification-safe.
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

    const upgradeRequested = query.upgrade === "1" || query.upgrade === "true";
    // A new user (no row yet) resolves to false -> sensitive-only consent.
    const includeModify = shouldRequestGmailModifyScope({
      modifyScopeGranted: conn?.modify_scope_granted ?? false,
      premiumEnabled: conn?.premium_enabled,
      upgradeRequested,
    });

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

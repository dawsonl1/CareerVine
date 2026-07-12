import { NextResponse } from "next/server";
import crypto from "crypto";
import { getAuthUrl } from "@/lib/gmail";
import { withApiHandler } from "@/lib/api-handler";
import { gmailAuthQuerySchema } from "@/lib/api-schemas";
import { resolveCapabilities } from "@/lib/capabilities/resolve";

/**
 * GET /api/gmail/auth?scopes=calendar
 * Generates a Google OAuth consent URL and redirects the user to it.
 * Uses a random nonce + user ID + timestamp for CSRF protection.
 * Optional query param: scopes=calendar to include Calendar scopes
 */
export const GET = withApiHandler({
  querySchema: gmailAuthQuerySchema,
  handler: async ({ user, query }) => {
    const includeCalendar = query.scopes === "calendar";

    // Preserve the restricted gmail.modify scope for users who are ALREADY premium
    // (modify_scope_granted && premium_enabled). Otherwise a premium user clicking
    // "Connect Calendar" or reconnecting would re-consent without modify and get
    // silently downgraded to the free tier. New / free users get sensitive-only, so
    // the default consent screen stays sensitive-only for verification (CAR-102).
    const isPremium = (await resolveCapabilities(user.id)).has("inbox:premium");

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

    const url = getAuthUrl(state, { includeCalendar, includeModify: isPremium });
    return NextResponse.redirect(url);
  },
});

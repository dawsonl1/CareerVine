import { NextResponse } from "next/server";
import crypto from "crypto";
import { getAuthUrl } from "@/lib/gmail";
import { withApiHandler } from "@/lib/api-handler";
import { gmailAuthQuerySchema } from "@/lib/api-schemas";

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

    // Build CSRF-safe state: random nonce + user ID + timestamp
    const nonce = crypto.randomBytes(16).toString("hex");
    const state = Buffer.from(JSON.stringify({
      userId: user.id,
      nonce,
      ts: Date.now()
    })).toString("base64url");

    const url = getAuthUrl(state, includeCalendar);
    return NextResponse.redirect(url);
  },
});

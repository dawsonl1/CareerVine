import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { google } from "googleapis";
import { getOAuth2Client } from "@/lib/oauth-helpers";
import { withApiHandler, ApiError } from "@/lib/api-handler";

/**
 * GET /api/gmail/callback
 * Handles the OAuth redirect from Google. Exchanges the authorization code
 * for tokens, stores them, and redirects back to settings.
 * Also detects if calendar scopes were granted.
 */
export const GET = withApiHandler({
  handler: async ({ user, request }) => {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");
    const baseUrl = new URL(request.url).origin;

    // Helper: redirect to settings with an error message
    const errorRedirect = (reason: string) =>
      NextResponse.redirect(
        `${baseUrl}/settings?gmail=error&reason=${encodeURIComponent(reason)}`
      );

    if (errorParam) {
      return errorRedirect(errorParam);
    }

    if (!code || !state) {
      return errorRedirect("Missing code or state");
    }

    // Validate CSRF state — decode and check user ID + freshness
    let stateData: { userId?: string; ts?: number };
    try {
      stateData = JSON.parse(Buffer.from(state, "base64url").toString());
    } catch {
      return errorRedirect("Invalid state");
    }

    if (stateData.userId !== user.id) {
      return errorRedirect("State mismatch");
    }

    if (stateData.ts && Date.now() - stateData.ts > 10 * 60 * 1000) {
      return errorRedirect("OAuth flow expired");
    }

    // Everything below talks to Google/Supabase — redirect on any failure
    try {
      const oauth2Client = getOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);
      const grantedScopes = tokens.scope?.split(" ") || [];
      const calendarGranted = grantedScopes.some(s => s.includes("calendar"));

      if (!tokens.access_token || !tokens.refresh_token) {
        return errorRedirect("Google did not return required tokens");
      }

      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const gmailAddress = profile.data.emailAddress || "";

      const serviceClient = createSupabaseServiceClient();
      const { error } = await serviceClient.from("gmail_connections").upsert(
        {
          user_id: user.id,
          gmail_address: gmailAddress,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: new Date(tokens.expiry_date || Date.now() + 3600_000).toISOString(),
          calendar_scopes_granted: calendarGranted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (error) {
        console.error("Error upserting gmail connection:", error);
        return errorRedirect("Failed to store connection");
      }

      return NextResponse.redirect(`${baseUrl}/settings?gmail=connected`);
    } catch (err) {
      console.error("Gmail callback error:", err);
      return errorRedirect("Connection failed — please try again");
    }
  },
});

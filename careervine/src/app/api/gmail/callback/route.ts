import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { google } from "googleapis";
import { getOAuth2Client, encryptOAuthToken } from "@/lib/oauth-helpers";
import { deriveGrantedScopeFlags } from "@/lib/gmail";
import { withApiHandler, ApiError } from "@/lib/api-handler";

/**
 * GET /api/gmail/callback
 * Handles the OAuth redirect from Google. Exchanges the authorization code
 * for tokens, stores them, and redirects back to settings.
 * Also detects if calendar scopes were granted.
 */
export const GET = withApiHandler({
  handler: async ({ user, request, track }) => {
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
    let stateData: { userId?: string; ts?: number; returnTo?: string };
    try {
      stateData = JSON.parse(Buffer.from(state, "base64url").toString());
    } catch {
      return errorRedirect("Invalid state");
    }

    // Same-origin relative landing path (CAR-50); anything suspect → /settings.
    const returnTo =
      stateData.returnTo && stateData.returnTo.startsWith("/") && !stateData.returnTo.startsWith("//")
        ? stateData.returnTo
        : null;

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
      // CAR-100/CAR-111: Gmail + Calendar share one consent screen with granular
      // (per-scope) consent, so a user can grant one capability while unchecking
      // another. Gate "connected" on what was ACTUALLY granted: send-capability for
      // Gmail, and BOTH calendar read+write (a partial calendar grant reads as not
      // connected, so the user re-prompts instead of hitting a mid-feature 403).
      const { sendGranted, calendarGranted, modifyGranted } = deriveGrantedScopeFlags(tokens.scope);

      if (!tokens.access_token || !tokens.refresh_token) {
        return errorRedirect("Google did not return required tokens");
      }

      oauth2Client.setCredentials(tokens);

      // Derive the connected email WITHOUT a Gmail read scope: free users hold only
      // gmail.send, so getProfile would 403. openid + email is always requested now,
      // so the id_token carries the address; fall back to the userinfo endpoint. We
      // never upsert an empty address — that would wipe gmail_address on reconnect.
      let gmailAddress = "";
      try {
        if (tokens.id_token) {
          const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
          });
          gmailAddress = ticket.getPayload()?.email?.toLowerCase() || "";
        }
      } catch (e) {
        console.warn("[gmail/callback] id_token verify failed:", e);
      }
      if (!gmailAddress) {
        try {
          const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
          const info = await oauth2.userinfo.get();
          gmailAddress = info.data.email?.toLowerCase() || "";
        } catch (e) {
          console.warn("[gmail/callback] userinfo fallback failed:", e);
        }
      }
      if (!gmailAddress) {
        return errorRedirect("Could not read your Google email address");
      }

      const serviceClient = createSupabaseServiceClient();
      // Brand-new free connects must land with premium_enabled=false so they do
      // not see inbox:upgrade / cannot self-serve into gmail.modify (CAR-131).
      // Existing rows keep whatever the admin set; never overwrite on reconnect.
      const { data: existing } = await serviceClient
        .from("gmail_connections")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      const { error } = await serviceClient.from("gmail_connections").upsert(
        {
          user_id: user.id,
          gmail_address: gmailAddress,
          access_token: encryptOAuthToken(tokens.access_token),
          refresh_token: encryptOAuthToken(tokens.refresh_token),
          token_expires_at: new Date(tokens.expiry_date || Date.now() + 3600_000).toISOString(),
          calendar_scopes_granted: calendarGranted,
          send_scope_granted: sendGranted,
          modify_scope_granted: modifyGranted,
          ...(!existing && !modifyGranted ? { premium_enabled: false } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (error) {
        console.error("Error upserting gmail connection:", error);
        return errorRedirect("Failed to store connection");
      }

      if (sendGranted) track("gmail_connected", {});
      if (calendarGranted) track("calendar_connected", {});

      return NextResponse.redirect(`${baseUrl}${returnTo ?? "/settings?gmail=connected"}`);
    } catch (err) {
      console.error("Gmail callback error:", err);
      return errorRedirect("Connection failed. Please try again");
    }
  },
});

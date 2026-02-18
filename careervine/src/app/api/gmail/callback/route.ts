import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { exchangeCodeForTokens } from "@/lib/gmail";
import { google } from "googleapis";

/**
 * GET /api/gmail/callback
 * Handles the OAuth redirect from Google. Exchanges the authorization code
 * for tokens, stores them, and redirects back to settings.
 * Also detects if calendar scopes were granted.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      const baseUrl = new URL(request.url).origin;
      return NextResponse.redirect(
        `${baseUrl}/settings?gmail=error&reason=${encodeURIComponent(errorParam)}`
      );
    }

    if (!code || !state) {
      return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate that the state matches the current user
    if (state !== user.id) {
      return NextResponse.json({ error: "State mismatch" }, { status: 403 });
    }

    // Exchange code for tokens
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await oauth2Client.getToken(code);
    const grantedScopes = tokens.scope?.split(" ") || [];
    const calendarGranted = grantedScopes.some(s => s.includes("calendar"));

    // Store tokens in database
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Missing access_token or refresh_token from Google");
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
      throw new Error("Failed to store Gmail connection");
    }

    const baseUrl = new URL(request.url).origin;
    return NextResponse.redirect(`${baseUrl}/settings?gmail=connected`);
  } catch (error) {
    console.error("Gmail callback error:", error);
    const baseUrl = new URL(request.url).origin;
    return NextResponse.redirect(
      `${baseUrl}/settings?gmail=error&reason=${encodeURIComponent(
        error instanceof Error ? error.message : "Unknown error"
      )}`
    );
  }
}

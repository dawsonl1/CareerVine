import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { getAuthUrl } from "@/lib/gmail";

/**
 * GET /api/gmail/auth?scopes=calendar
 * Generates a Google OAuth consent URL and redirects the user to it.
 * Uses a random nonce + user ID + timestamp for CSRF protection.
 * Optional query param: scopes=calendar to include Calendar scopes
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const includeCalendar = searchParams.get("scopes") === "calendar";

    // Build CSRF-safe state: random nonce + user ID + timestamp
    const nonce = crypto.randomBytes(16).toString("hex");
    const state = Buffer.from(JSON.stringify({
      userId: user.id,
      nonce,
      ts: Date.now()
    })).toString("base64url");

    const url = getAuthUrl(state, includeCalendar);
    return NextResponse.redirect(url);
  } catch (error) {
    console.error("Gmail auth error:", error);
    return NextResponse.json(
      { error: "Failed to initiate Gmail auth" },
      { status: 500 }
    );
  }
}

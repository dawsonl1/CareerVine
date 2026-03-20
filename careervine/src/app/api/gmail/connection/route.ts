import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/connection
 * Fetches the current Gmail/Calendar connection status and settings for the user.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("gmail_connections")
      .select("id, gmail_address, last_gmail_sync_at, created_at, calendar_scopes_granted, calendar_last_synced_at, availability_standard, availability_priority, calendar_list, busy_calendar_ids, calendar_timezone")
      .eq("user_id", user.id)
      .single();

    if (error || !data) {
      return NextResponse.json({ connection: null });
    }

    return NextResponse.json({ connection: data });
  } catch (error) {
    console.error("Connection fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch connection" },
      { status: 500 }
    );
  }
}

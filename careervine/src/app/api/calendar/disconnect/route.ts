import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/disconnect
 * Disconnects Calendar from CareerVine (clears calendar_scopes_granted and deletes cached events).
 * Does NOT disconnect Gmail.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const service = createSupabaseServiceClient();

    // Clear calendar scopes and sync state
    await service
      .from("gmail_connections")
      .update({
        calendar_scopes_granted: false,
        calendar_sync_token: null,
        calendar_last_synced_at: null,
      })
      .eq("user_id", user.id);

    // Delete all cached calendar events for this user
    await service
      .from("calendar_events")
      .delete()
      .eq("user_id", user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Calendar disconnect error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect calendar" },
      { status: 500 }
    );
  }
}

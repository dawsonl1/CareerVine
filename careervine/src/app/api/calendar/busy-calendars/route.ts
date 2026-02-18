import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/busy-calendars
 * Saves the user's selected calendar IDs that count as "busy" for availability.
 * Body: { busyCalendarIds: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { busyCalendarIds } = body;

    if (!Array.isArray(busyCalendarIds)) {
      return NextResponse.json({ error: "busyCalendarIds must be an array" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();
    await service
      .from("gmail_connections")
      .update({ busy_calendar_ids: busyCalendarIds })
      .eq("user_id", user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { updateCalendarEvent, deleteCalendarEvent } from "@/lib/calendar";

/**
 * PATCH /api/calendar/events/[googleEventId]
 * Updates a Google Calendar event and the local cache row.
 * Body: { summary?, description?, startTime?, endTime? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ googleEventId: string }> }
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { googleEventId } = await params;
    const body = await request.json();
    const { summary, description, startTime, endTime } = body;

    await updateCalendarEvent(user.id, googleEventId, { summary, description, startTime, endTime });

    const service = createSupabaseServiceClient();
    const update: Record<string, unknown> = { synced_at: new Date().toISOString() };
    if (summary) update.title = summary;
    if (description != null) update.description = description;
    if (startTime) update.start_at = new Date(startTime).toISOString();
    if (endTime) update.end_at = new Date(endTime).toISOString();

    await service
      .from("calendar_events")
      .update(update)
      .eq("google_event_id", googleEventId)
      .eq("user_id", user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Update calendar event error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update event" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/calendar/events/[googleEventId]
 * Deletes a Google Calendar event and removes it from the local cache.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ googleEventId: string }> }
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { googleEventId } = await params;

    await deleteCalendarEvent(user.id, googleEventId);

    const service = createSupabaseServiceClient();
    await service
      .from("calendar_events")
      .delete()
      .eq("google_event_id", googleEventId)
      .eq("user_id", user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete calendar event error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete event" },
      { status: 500 }
    );
  }
}

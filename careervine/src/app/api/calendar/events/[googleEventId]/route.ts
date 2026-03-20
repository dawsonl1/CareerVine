import { withApiHandler } from "@/lib/api-handler";
import { calendarEventPatchSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { updateCalendarEvent, deleteCalendarEvent } from "@/lib/calendar";

/**
 * PATCH /api/calendar/events/[googleEventId]
 * Updates a Google Calendar event and the local cache row.
 * Body: { summary?, description?, startTime?, endTime? }
 */
export const PATCH = withApiHandler({
  schema: calendarEventPatchSchema,
  handler: async ({ user, params, body }) => {
    const { googleEventId } = params;
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

    return { success: true };
  },
});

/**
 * DELETE /api/calendar/events/[googleEventId]
 * Deletes a Google Calendar event and removes it from the local cache.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { googleEventId } = params;

    await deleteCalendarEvent(user.id, googleEventId);

    const service = createSupabaseServiceClient();
    await service
      .from("calendar_events")
      .delete()
      .eq("google_event_id", googleEventId)
      .eq("user_id", user.id);

    return { success: true };
  },
});

import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { deleteCalendarEvent } from "@/lib/calendar";

/**
 * POST /api/onboarding/skip
 * Marks onboarding complete and cleans up any onboarding calendar event.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    // Fetch the onboarding row to get any calendar event to clean up
    const { data: onboarding } = await service
      .from("user_onboarding")
      .select("onboarding_calendar_event_id")
      .eq("user_id", user.id)
      .single();

    // Clean up simulated calendar event and associated meeting row
    if (onboarding?.onboarding_calendar_event_id) {
      try {
        await deleteCalendarEvent(user.id, onboarding.onboarding_calendar_event_id);
      } catch (err) {
        console.error("[onboarding/skip] Failed to delete calendar event:", err);
      }
      // Delete the onboarding meeting row (cascades to meeting_contacts)
      await service
        .from("meetings")
        .delete()
        .eq("user_id", user.id)
        .eq("calendar_event_id", onboarding.onboarding_calendar_event_id);

      // Delete the local calendar_events cache entry
      await service
        .from("calendar_events")
        .delete()
        .eq("user_id", user.id)
        .eq("google_event_id", onboarding.onboarding_calendar_event_id);
    }

    // Mark onboarding complete and clear stale calendar event reference
    await service
      .from("user_onboarding")
      .update({
        current_step: "complete",
        completed_at: new Date().toISOString(),
        onboarding_calendar_event_id: null,
      })
      .eq("user_id", user.id);

    return { status: "skipped" };
  },
});

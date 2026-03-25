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

    // Delete the simulated calendar event if one was created
    if (onboarding?.onboarding_calendar_event_id) {
      try {
        await deleteCalendarEvent(user.id, onboarding.onboarding_calendar_event_id);
      } catch (err) {
        // Don't block skipping if calendar deletion fails
        console.error("[onboarding/skip] Failed to delete calendar event:", err);
      }
    }

    // Mark onboarding complete
    await service
      .from("user_onboarding")
      .update({
        current_step: "complete",
        completed_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return { status: "skipped" };
  },
});

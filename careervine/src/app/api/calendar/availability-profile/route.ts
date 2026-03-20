import { withApiHandler } from "@/lib/api-handler";
import { calendarAvailabilityProfileSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/availability-profile
 * Saves availability profile (standard or priority) for the user.
 */
export const POST = withApiHandler({
  schema: calendarAvailabilityProfileSchema,
  handler: async ({ user, body }) => {
    const { profile, data } = body;

    const service = createSupabaseServiceClient();
    const updateData = profile === "standard"
      ? { availability_standard: data }
      : { availability_priority: data };

    const { error } = await service
      .from("gmail_connections")
      .update(updateData)
      .eq("user_id", user.id);

    if (error) throw error;

    return { success: true };
  },
});

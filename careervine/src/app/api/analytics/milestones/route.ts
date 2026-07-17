import { withApiHandler } from "@/lib/api-handler";
import { checkContactMilestone } from "@/lib/analytics/server";

/**
 * POST /api/analytics/milestones
 * Re-evaluates count-threshold milestones for the authenticated user.
 * Exists for client-side contact creation (the manual add form inserts via
 * the browser Supabase client, so no server code path sees the new row) —
 * every server-side import path runs the check inline instead (CAR-58).
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    await checkContactMilestone(user.id);
    return { success: true };
  },
});

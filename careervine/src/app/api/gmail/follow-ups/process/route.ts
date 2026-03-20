import { withApiHandler } from "@/lib/api-handler";
import { processFollowUps } from "@/lib/gmail";

/**
 * POST /api/gmail/follow-ups/process
 * Processes all due follow-up messages for the authenticated user.
 * Checks for replies before sending each follow-up.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const result = await processFollowUps(user.id);
    return { success: true, ...result };
  },
});

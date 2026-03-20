import { withApiHandler } from "@/lib/api-handler";
import { processScheduledEmails } from "@/lib/gmail";

/**
 * POST /api/gmail/schedule/process
 * Sends all due scheduled emails for the authenticated user.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const result = await processScheduledEmails(user.id);
    return { success: true, ...result };
  },
});

import { withApiHandler } from "@/lib/api-handler";
import { markMessageAsRead } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/read
 * Marks a message as read in both Gmail and the local cache.
 */
export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;
    await markMessageAsRead(user.id, messageId);
    return { success: true };
  },
});

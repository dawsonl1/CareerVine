import { withApiHandler } from "@/lib/api-handler";
import { getFullMessage } from "@/lib/gmail";

/**
 * GET /api/gmail/emails/[messageId]
 * Fetches the full email body from Gmail API on demand.
 */
export const GET = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;
    const message = await getFullMessage(user.id, messageId);
    return { success: true, message };
  },
});

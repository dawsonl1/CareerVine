import { withApiHandler } from "@/lib/api-handler";
import { getFullMessage } from "@/lib/gmail";

/**
 * GET /api/gmail/emails/[messageId]
 * Fetches the full email body from Gmail API on demand. Live mailbox read —
 * premium only (CAR-102); free users have no gmail.modify scope.
 */
export const GET = withApiHandler({
  requireCapability: "mailbox:read",
  handler: async ({ user, params }) => {
    const { messageId } = params;
    const message = await getFullMessage(user.id, messageId);
    return { success: true, message };
  },
});

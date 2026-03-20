import { withApiHandler } from "@/lib/api-handler";
import { trashMessage, untrashMessage } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/trash
 * Moves the email to Gmail's trash and marks it trashed locally.
 */
export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;
    await trashMessage(user.id, messageId);
    return { success: true };
  },
});

/**
 * DELETE /api/gmail/emails/[messageId]/trash
 * Restores the email from Gmail's trash (untrash).
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;
    await untrashMessage(user.id, messageId);
    return { success: true };
  },
});

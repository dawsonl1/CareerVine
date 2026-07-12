import { withApiHandler } from "@/lib/api-handler";
import { trashMessage, untrashMessage } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/trash
 * Moves the email to Gmail's trash and marks it trashed locally. Live mailbox
 * mutation — premium only (CAR-102).
 */
export const POST = withApiHandler({
  requireCapability: "mailbox:modify",
  handler: async ({ user, params }) => {
    const { messageId } = params;
    await trashMessage(user.id, messageId);
    return { success: true };
  },
});

/**
 * DELETE /api/gmail/emails/[messageId]/trash
 * Restores the email from Gmail's trash (untrash). Live mailbox mutation —
 * premium only (CAR-102).
 */
export const DELETE = withApiHandler({
  requireCapability: "mailbox:modify",
  handler: async ({ user, params }) => {
    const { messageId } = params;
    await untrashMessage(user.id, messageId);
    return { success: true };
  },
});

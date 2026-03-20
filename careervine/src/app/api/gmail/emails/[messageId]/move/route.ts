import { withApiHandler } from "@/lib/api-handler";
import { gmailEmailMoveSchema } from "@/lib/api-schemas";
import { moveMessageToLabel } from "@/lib/gmail";

/**
 * POST /api/gmail/emails/[messageId]/move
 * Moves an email to a Gmail label/folder and removes it from the webapp.
 * Body: { labelId: string }
 */
export const POST = withApiHandler({
  schema: gmailEmailMoveSchema,
  handler: async ({ user, params, body }) => {
    const { messageId } = params;
    const { labelId } = body;
    await moveMessageToLabel(user.id, messageId, labelId);
    return { success: true };
  },
});

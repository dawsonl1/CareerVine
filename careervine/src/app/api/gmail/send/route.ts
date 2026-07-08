import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailSendSchema } from "@/lib/api-schemas";
import { sendTrackedEmail, SendPolicyError } from "@/lib/email-send";

/**
 * POST /api/gmail/send
 * Sends an email through the user's connected Gmail account.
 * All policy (daily cap, bounce refusal, caching, interaction logging)
 * lives in the shared sendTrackedEmail() so the app and the MCP server
 * can never disagree on send behavior.
 */
export const POST = withApiHandler({
  schema: gmailSendSchema,
  handler: async ({ user, body }) => {
    const { to, cc, bcc, subject, bodyHtml, threadId, inReplyTo, references } = body;

    try {
      const result = await sendTrackedEmail(user.id, {
        to, cc, bcc, subject,
        bodyHtml: bodyHtml || "",
        threadId, inReplyTo, references,
      });
      return { success: true, messageId: result.messageId, threadId: result.threadId };
    } catch (err) {
      if (err instanceof SendPolicyError) throw new ApiError(err.message, err.status);
      throw err;
    }
  },
});

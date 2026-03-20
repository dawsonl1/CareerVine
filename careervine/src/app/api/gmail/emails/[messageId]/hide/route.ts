import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/gmail/emails/[messageId]/hide
 * Hides an email from the webapp only (does not affect Gmail).
 */
export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;

    const service = createSupabaseServiceClient();
    await service
      .from("email_messages")
      .update({ is_hidden: true })
      .eq("user_id", user.id)
      .eq("gmail_message_id", messageId);

    return { success: true };
  },
});

/**
 * DELETE /api/gmail/emails/[messageId]/hide
 * Unhides an email, restoring it to the main inbox view.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;

    const service = createSupabaseServiceClient();
    await service
      .from("email_messages")
      .update({ is_hidden: false })
      .eq("user_id", user.id)
      .eq("gmail_message_id", messageId);

    return { success: true };
  },
});

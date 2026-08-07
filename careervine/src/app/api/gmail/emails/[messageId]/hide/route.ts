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
 *
 * Clears `is_excluded` too (CAR-260). Striking a message from the record sets
 * both flags, so the Hidden tab is where a struck email surfaces and is
 * therefore its undo surface: leaving `is_excluded` set here would put the
 * message back in the inbox while it silently went on not counting toward any
 * calculation, with nothing on screen saying so.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { messageId } = params;

    const service = createSupabaseServiceClient();
    await service
      .from("email_messages")
      .update({ is_hidden: false, is_excluded: false })
      .eq("user_id", user.id)
      .eq("gmail_message_id", messageId);

    return { success: true };
  },
});

import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { recordThreadReply } from "@/lib/follow-up-reply";

const schema = z.object({
  threadId: z.string().min(1),
  recipientEmail: z.string().email(),
});

/**
 * POST /api/gmail/follow-ups/mark-replied — manual "they replied" (CAR-102).
 *
 * Free users hold only the gmail.send scope, so the cron cannot auto-detect
 * replies. This restores it by hand: cancel any active follow-up sequence on the
 * thread, graduate the contact, and fire reply_received once (idempotent). Not
 * gated — sending/tracking need no live scope.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  schema,
  handler: async ({ user, body }) => {
    const { threadId, recipientEmail } = body;
    const service = createSupabaseServiceClient();

    // Ownership guard: the user must have actually sent on this thread. (The
    // helper is also called from the confirm route, where ownership is already
    // established via the follow-up message, so the guard lives here.)
    const { data: outbound } = await service
      .from("email_messages")
      .select("id")
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .eq("direction", "outbound")
      .limit(1)
      .maybeSingle();
    if (!outbound) {
      throw new ApiError("No sent message found on this thread.", 404);
    }

    // One success shape (CAR-149): map the helper's `{ ok, alreadyMarked }` to
    // the app-wide `{ success: true, ... }` convention — matches the sibling
    // confirm route, which calls the same helper.
    const result = await recordThreadReply(user.id, threadId, recipientEmail);
    return { success: true, alreadyMarked: result.alreadyMarked };
  },
});

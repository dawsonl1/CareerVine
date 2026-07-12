import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { activateContactByEmail } from "@/lib/gmail";
import { trackServer } from "@/lib/analytics/server";

const schema = z.object({
  threadId: z.string().min(1),
  recipientEmail: z.string().email(),
});

/**
 * POST /api/gmail/follow-ups/mark-replied — manual "they replied" (CAR-102).
 *
 * Free users hold only the gmail.send scope, so the cron cannot auto-detect
 * replies. This restores that behavior by hand: cancel any active follow-up
 * sequence on the thread, graduate the contact to active, record a simulated
 * inbound message so the thread shows the reply, and fire the reply_received
 * north-star event once. Idempotent: keyed on the simulated inbound row (a
 * thread that already has any inbound message is a no-op re-fire), so clicking
 * twice never double-counts. Not gated — sending/tracking use no live scope.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  schema,
  handler: async ({ user, body }) => {
    const { threadId, recipientEmail } = body;
    const service = createSupabaseServiceClient();

    // Ownership guard: the user must have sent on this thread. Also grabs the
    // ai_assisted flag + contact link for the event and the simulated row.
    const { data: outbound } = await service
      .from("email_messages")
      .select("ai_assisted, matched_contact_id")
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .eq("direction", "outbound")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!outbound) {
      throw new ApiError("No sent message found on this thread.", 404);
    }

    // Idempotency: a thread that already has an inbound message (a real synced
    // reply, or a prior manual mark) is already "replied" — cancel/activate are
    // safe to repeat, but we must not record or fire a second time.
    const { data: existingInbound } = await service
      .from("email_messages")
      .select("id")
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .limit(1)
      .maybeSingle();

    // Cancel active follow-up sequences on this thread (mirrors the cron's
    // reply-cancel: sequence -> cancelled_reply, pending messages -> cancelled).
    const { data: seqs } = await service
      .from("email_follow_ups")
      .select("id")
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .eq("status", "active");
    const now = new Date().toISOString();
    for (const s of seqs ?? []) {
      await service
        .from("email_follow_ups")
        .update({ status: "cancelled_reply", updated_at: now })
        .eq("id", s.id);
      await service
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("follow_up_id", s.id)
        .eq("status", "pending");
    }

    // Graduate the contact into the active network (no-op if unmatched/already active).
    await activateContactByEmail(user.id, recipientEmail);

    if (existingInbound) {
      return { ok: true, alreadyMarked: true };
    }

    // Record a simulated inbound message so the thread reflects the reply and
    // future marks dedupe against it (mirrors the is_simulated convention).
    // gmail_message_id is thread-derived so the (user_id, gmail_message_id)
    // unique constraint enforces one manual reply per thread.
    await service.from("email_messages").insert({
      user_id: user.id,
      gmail_message_id: `manual-reply-${threadId}`,
      thread_id: threadId,
      snippet: "Marked as replied",
      from_address: recipientEmail,
      date: now,
      direction: "inbound",
      is_read: true,
      is_simulated: true,
      matched_contact_id: outbound.matched_contact_id ?? null,
    });

    // North-star: a reply happened. ai_assisted mirrors the outbound side.
    await trackServer(user.id, "reply_received", { ai_assisted: outbound.ai_assisted === true });

    return { ok: true };
  },
});

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { activateContactByEmail } from "@/lib/gmail";
import { trackServer } from "@/lib/analytics/server";
import { UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES } from "@/lib/constants";

/**
 * Record that a contact replied on a thread — the free-tier manual reply signal
 * (CAR-102). Free users hold only the gmail.send scope, so the cron cannot detect
 * replies; this reproduces that behavior by hand.
 *
 * Cancels active follow-up sequences on the thread (pending AND awaiting_review
 * messages), graduates the contact into the active network, and fires the
 * reply_received north-star EXACTLY ONCE. Idempotency is keyed on a simulated
 * inbound email_messages row (unique per thread), so repeated marks/confirms
 * across both the "Mark as replied" and confirm(replied=true) paths never
 * double-count. Returns whether the reply was already recorded.
 */
export async function recordThreadReply(
  userId: string,
  threadId: string,
  recipientEmail: string,
): Promise<{ ok: true; alreadyMarked: boolean }> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();

  // Cancel active sequences on this thread (mirrors the cron's reply-cancel;
  // clears both pending and awaiting_review messages so none are orphaned).
  const { data: seqs } = await service
    .from("email_follow_ups")
    .select("id")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("status", "active");
  for (const s of seqs ?? []) {
    await service
      .from("email_follow_ups")
      .update({ status: "cancelled_reply", updated_at: now })
      .eq("id", s.id);
    await service
      .from("email_follow_up_messages")
      .update({ status: "cancelled" })
      .eq("follow_up_id", s.id)
      // Clear expired too (CAR-105): a still-sendable expired sibling must not
      // orphan under a now-cancelled parent.
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
  }

  // Graduate the contact (no-op if unmatched / already active).
  await activateContactByEmail(userId, recipientEmail);

  // Idempotency: a thread with any inbound message (a real synced reply or a
  // prior manual mark) is already recorded — don't fire the event twice.
  const { data: existingInbound } = await service
    .from("email_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .limit(1)
    .maybeSingle();
  if (existingInbound) return { ok: true, alreadyMarked: true };

  // ai_assisted + contact link come from the latest outbound on the thread.
  const { data: outbound } = await service
    .from("email_messages")
    .select("ai_assisted, matched_contact_id")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("direction", "outbound")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Simulated inbound row: reflects the reply in the thread and dedupes future
  // calls (the (user_id, gmail_message_id) unique constraint enforces one/thread).
  const { error: insertErr } = await service.from("email_messages").insert({
    user_id: userId,
    gmail_message_id: `manual-reply-${threadId}`,
    thread_id: threadId,
    snippet: "Marked as replied",
    from_address: recipientEmail,
    date: now,
    direction: "inbound",
    is_read: true,
    is_simulated: true,
    matched_contact_id: (outbound as { matched_contact_id?: number | null } | null)?.matched_contact_id ?? null,
  });

  // The existingInbound check above closes the common case, but two concurrent
  // marks/confirms can both pass it and race to insert. The unique constraint
  // lets exactly one win; the loser gets an insert error. Treat that as
  // already-recorded so reply_received fires EXACTLY once, never twice.
  if (insertErr) {
    return { ok: true, alreadyMarked: true };
  }

  await trackServer(userId, "reply_received", {
    ai_assisted: (outbound as { ai_assisted?: boolean } | null)?.ai_assisted === true,
  });
  return { ok: true, alreadyMarked: false };
}

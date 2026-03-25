import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getGmailClient } from "@/lib/gmail";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

/**
 * POST /api/cron/send-follow-ups
 * Called by QStash every 15 minutes. Processes due follow-up emails:
 * - Checks for replies in the thread (cancels if replied)
 * - Sends pending follow-ups via Gmail as replies
 * - Handles disconnected Gmail gracefully
 */
export async function POST(req: NextRequest) {
  // Verify QStash signature
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // Query pending follow-up messages that are due
  const { data: pendingMessages } = await service
    .from("email_follow_up_messages")
    .select(`
      id, follow_up_id, subject, body_html, scheduled_send_at,
      email_follow_ups!inner(
        id, user_id, thread_id, recipient_email, contact_name,
        original_gmail_message_id, original_subject, status
      )
    `)
    .eq("status", "pending")
    .lte("scheduled_send_at", now)
    .not("email_follow_ups.thread_id", "is", null)
    .eq("email_follow_ups.status", "active")
    .order("scheduled_send_at", { ascending: true })
    .limit(20);

  if (!pendingMessages || pendingMessages.length === 0) {
    return NextResponse.json({ processed: 0, sent: 0, cancelled: 0 });
  }

  let sent = 0;
  let cancelled = 0;

  // Group by follow_up_id to batch reply detection
  const bySequence = new Map<number, typeof pendingMessages>();
  for (const msg of pendingMessages) {
    const seqId = msg.follow_up_id;
    if (!bySequence.has(seqId)) bySequence.set(seqId, []);
    bySequence.get(seqId)!.push(msg);
  }

  for (const [seqId, messages] of bySequence) {
    const parent = (messages[0] as any).email_follow_ups;
    const userId = parent.user_id;
    const threadId = parent.thread_id;

    // Check if Gmail is accessible for this user
    let gmail;
    try {
      gmail = await getGmailClient(userId);
    } catch {
      // Gmail disconnected — check if messages are stale (3+ days past due)
      const oldestMsg = messages[0];
      if (oldestMsg.scheduled_send_at < threeDaysAgo) {
        // Cancel the entire sequence
        await service
          .from("email_follow_ups")
          .update({ status: "cancelled_user", updated_at: now })
          .eq("id", seqId);
        await service
          .from("email_follow_up_messages")
          .update({ status: "cancelled" })
          .eq("follow_up_id", seqId)
          .eq("status", "pending");
        cancelled += messages.length;
      }
      // Otherwise skip — will retry next cycle
      continue;
    }

    // Check for replies in the thread (one API call per thread)
    let hasReply = false;
    try {
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From"],
      });

      const threadMessages = thread.data.messages || [];
      // If there are more messages than just the original, check if any are from someone else
      if (threadMessages.length > 1) {
        const { data: conn } = await service
          .from("gmail_connections")
          .select("gmail_address")
          .eq("user_id", userId)
          .single();
        const userEmail = conn?.gmail_address?.toLowerCase() || "";

        hasReply = threadMessages.some((m) => {
          const fromHeader = m.payload?.headers?.find(
            (h) => h.name?.toLowerCase() === "from"
          );
          const from = fromHeader?.value?.toLowerCase() || "";
          return !from.includes(userEmail);
        });
      }
    } catch {
      // If thread check fails, skip this cycle (don't send, don't cancel)
      continue;
    }

    if (hasReply) {
      // Cancel the entire sequence — they replied!
      await service
        .from("email_follow_ups")
        .update({ status: "cancelled_reply", updated_at: now })
        .eq("id", seqId);
      await service
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("follow_up_id", seqId)
        .eq("status", "pending");
      cancelled += messages.length;
      continue;
    }

    // Send each due message in this sequence
    for (const msg of messages) {
      // Atomic status check: set to 'sending' to prevent duplicates
      const { data: updated } = await service
        .from("email_follow_up_messages")
        .update({ status: "sending" })
        .eq("id", msg.id)
        .eq("status", "pending")
        .select("id")
        .single();

      if (!updated) continue; // Already being processed

      try {
        await sendEmail(userId, {
          to: parent.recipient_email,
          subject: msg.subject,
          bodyHtml: msg.body_html,
          threadId: threadId,
          inReplyTo: parent.original_gmail_message_id,
          references: parent.original_gmail_message_id,
        });

        await service
          .from("email_follow_up_messages")
          .update({ status: "sent", sent_at: now })
          .eq("id", msg.id);

        sent++;
      } catch (err) {
        console.error(`[cron] Failed to send follow-up ${msg.id}:`, err);
        // Revert to pending so it's retried next cycle
        await service
          .from("email_follow_up_messages")
          .update({ status: "pending" })
          .eq("id", msg.id);
      }
    }

    // Check if all messages in the sequence are now sent
    const { count } = await service
      .from("email_follow_up_messages")
      .select("id", { count: "exact", head: true })
      .eq("follow_up_id", seqId)
      .eq("status", "pending");

    if (count === 0) {
      await service
        .from("email_follow_ups")
        .update({ status: "completed", updated_at: now })
        .eq("id", seqId);
    }
  }

  return NextResponse.json({
    processed: pendingMessages.length,
    sent,
    cancelled,
  });
}

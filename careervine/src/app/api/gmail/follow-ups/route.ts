import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/follow-ups?threadId=xxx
 * Returns follow-up sequences for a thread or all active ones.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const threadId = request.nextUrl.searchParams.get("threadId");
    const service = createSupabaseServiceClient();

    let query = service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (threadId) {
      query = query.eq("thread_id", threadId);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ followUps: data || [] });
  } catch (error) {
    console.error("Follow-ups fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch follow-ups" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/gmail/follow-ups
 * Creates a new follow-up sequence with one or more scheduled messages.
 *
 * Body: {
 *   originalGmailMessageId, threadId, recipientEmail, contactName,
 *   originalSubject, originalSentAt,
 *   messages: [{ sendAfterDays, subject, bodyHtml }]
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      originalGmailMessageId,
      threadId,
      recipientEmail,
      contactName,
      originalSubject,
      originalSentAt,
      scheduledEmailId,
      messages,
    } = body;

    if (!originalGmailMessageId || !threadId || !recipientEmail || !messages?.length) {
      return NextResponse.json(
        { error: "originalGmailMessageId, threadId, recipientEmail, and messages are required" },
        { status: 400 }
      );
    }

    const service = createSupabaseServiceClient();

    // Create the follow-up sequence
    const { data: followUp, error: fuError } = await service
      .from("email_follow_ups")
      .insert({
        user_id: user.id,
        original_gmail_message_id: originalGmailMessageId,
        thread_id: threadId,
        recipient_email: recipientEmail,
        contact_name: contactName || null,
        original_subject: originalSubject || null,
        original_sent_at: originalSentAt,
        status: "active",
        scheduled_email_id: scheduledEmailId || null,
      })
      .select()
      .single();

    if (fuError) throw fuError;

    // Create the individual follow-up messages
    const sentAt = new Date(originalSentAt);
    const msgRows = messages.map((m: { sendAfterDays: number; subject: string; bodyHtml: string; sendTime?: string }, idx: number) => {
      const scheduledDate = new Date(sentAt);
      scheduledDate.setDate(scheduledDate.getDate() + m.sendAfterDays);
      if (m.sendTime) {
        const [h, min] = m.sendTime.split(":").map(Number);
        scheduledDate.setHours(h, min, 0, 0);
      } else {
        scheduledDate.setHours(9, 0, 0, 0);
      }
      return {
        follow_up_id: followUp.id,
        sequence_number: idx + 1,
        send_after_days: m.sendAfterDays,
        subject: m.subject,
        body_html: m.bodyHtml,
        status: "pending",
        scheduled_send_at: scheduledDate.toISOString(),
      };
    });

    const { error: msgError } = await service
      .from("email_follow_up_messages")
      .insert(msgRows);

    if (msgError) throw msgError;

    // Fetch the complete follow-up with messages
    const { data: complete } = await service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("id", followUp.id)
      .single();

    return NextResponse.json({ followUp: complete });
  } catch (error) {
    console.error("Follow-up creation error:", error);
    return NextResponse.json(
      { error: "Failed to create follow-up" },
      { status: 500 }
    );
  }
}

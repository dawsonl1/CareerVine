import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * PUT /api/gmail/follow-ups/[id]
 * Updates the pending messages in a follow-up sequence.
 * Deletes all existing pending messages and replaces them with new ones.
 *
 * Body: { messages: [{ sendAfterDays, subject, bodyHtml }] }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const followUpId = parseInt(id, 10);
    if (isNaN(followUpId)) {
      return NextResponse.json({ error: "Invalid follow-up ID" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();

    // Verify ownership and get original_sent_at
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("*")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (followUp.status !== "active") {
      return NextResponse.json({ error: "Can only edit active follow-ups" }, { status: 400 });
    }

    const { messages } = await request.json();
    if (!messages?.length) {
      return NextResponse.json({ error: "At least one message is required" }, { status: 400 });
    }

    // Delete existing pending messages
    await service
      .from("email_follow_up_messages")
      .delete()
      .eq("follow_up_id", followUpId)
      .eq("status", "pending");

    // Insert new messages
    const sentAt = new Date(followUp.original_sent_at);
    const msgRows = messages.map((m: { sendAfterDays: number; subject: string; bodyHtml: string; sendTime?: string }, idx: number) => {
      const scheduledDate = new Date(sentAt);
      scheduledDate.setDate(scheduledDate.getDate() + m.sendAfterDays);
      if (m.sendTime) {
        const [h, min] = m.sendTime.split(":").map(Number);
        scheduledDate.setHours(h, min, 0, 0);
      } else {
        scheduledDate.setHours(9, 0, 0, 0);
      }
      // Get the next sequence number (after any already-sent messages)
      return {
        follow_up_id: followUpId,
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

    // Update timestamp
    await service
      .from("email_follow_ups")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", followUpId);

    // Return updated follow-up
    const { data: complete } = await service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("id", followUpId)
      .single();

    return NextResponse.json({ followUp: complete });
  } catch (error) {
    console.error("Follow-up update error:", error);
    return NextResponse.json(
      { error: "Failed to update follow-up" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gmail/follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const followUpId = parseInt(id, 10);
    if (isNaN(followUpId)) {
      return NextResponse.json({ error: "Invalid follow-up ID" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();

    // Verify ownership
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("id, user_id")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    // Cancel all pending messages
    await service
      .from("email_follow_up_messages")
      .update({ status: "cancelled" })
      .eq("follow_up_id", followUpId)
      .eq("status", "pending");

    // Update the sequence status
    await service
      .from("email_follow_ups")
      .update({ status: "cancelled_user", updated_at: now })
      .eq("id", followUpId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Follow-up cancel error:", error);
    return NextResponse.json(
      { error: "Failed to cancel follow-up" },
      { status: 500 }
    );
  }
}

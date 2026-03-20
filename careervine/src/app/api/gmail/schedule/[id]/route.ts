import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * PUT /api/gmail/schedule/[id]
 * Updates a pending scheduled email.
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
    const emailId = parseInt(id, 10);
    if (isNaN(emailId)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();

    const { data: existing } = await service
      .from("scheduled_emails")
      .select("id, user_id, status")
      .eq("id", emailId)
      .single();

    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.status !== "pending") {
      return NextResponse.json({ error: "Can only edit pending emails" }, { status: 400 });
    }

    const body = await request.json();
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.to !== undefined) updates.recipient_email = body.to;
    if (body.cc !== undefined) updates.cc = body.cc || null;
    if (body.bcc !== undefined) updates.bcc = body.bcc || null;
    if (body.subject !== undefined) updates.subject = body.subject;
    if (body.bodyHtml !== undefined) updates.body_html = body.bodyHtml;
    if (body.scheduledSendAt !== undefined) updates.scheduled_send_at = body.scheduledSendAt;

    const { data, error } = await service
      .from("scheduled_emails")
      .update(updates)
      .eq("id", emailId)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ scheduledEmail: data });
  } catch (error) {
    console.error("Update scheduled email error:", error);
    return NextResponse.json(
      { error: "Failed to update" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/gmail/schedule/[id]
 * Cancels a pending scheduled email and any linked follow-ups.
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
    const emailId = parseInt(id, 10);
    if (isNaN(emailId)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();

    const { data: existing } = await service
      .from("scheduled_emails")
      .select("id, user_id")
      .eq("id", emailId)
      .single();

    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    // Cancel linked follow-ups
    const { data: linkedFollowUps } = await service
      .from("email_follow_ups")
      .select("id")
      .eq("scheduled_email_id", emailId)
      .eq("status", "active");

    if (linkedFollowUps && linkedFollowUps.length > 0) {
      const fuIds = linkedFollowUps.map((fu) => fu.id);
      await service
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .in("follow_up_id", fuIds)
        .eq("status", "pending");

      await service
        .from("email_follow_ups")
        .update({ status: "cancelled_user", updated_at: now })
        .in("id", fuIds);
    }

    // Cancel the scheduled email
    await service
      .from("scheduled_emails")
      .update({ status: "cancelled", updated_at: now })
      .eq("id", emailId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cancel scheduled email error:", error);
    return NextResponse.json(
      { error: "Failed to cancel" },
      { status: 500 }
    );
  }
}

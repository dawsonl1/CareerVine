import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/schedule?contactId=xxx
 * Returns pending scheduled emails, optionally filtered by contact.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contactId = request.nextUrl.searchParams.get("contactId");
    const service = createSupabaseServiceClient();

    let query = service
      .from("scheduled_emails")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("scheduled_send_at", { ascending: true });

    if (contactId) {
      query = query.eq("matched_contact_id", parseInt(contactId, 10));
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ scheduledEmails: data || [] });
  } catch (error) {
    console.error("Scheduled emails fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch scheduled emails" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/gmail/schedule
 * Creates a new scheduled email.
 *
 * Body: { to, cc?, bcc?, subject, bodyHtml, scheduledSendAt,
 *         threadId?, inReplyTo?, references?, contactName?, matchedContactId? }
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
      to, cc, bcc, subject, bodyHtml, scheduledSendAt,
      threadId, inReplyTo, references,
      contactName, matchedContactId,
    } = body;

    if (!to || !subject || !scheduledSendAt) {
      return NextResponse.json(
        { error: "to, subject, and scheduledSendAt are required" },
        { status: 400 }
      );
    }

    const service = createSupabaseServiceClient();

    const { data, error } = await service
      .from("scheduled_emails")
      .insert({
        user_id: user.id,
        recipient_email: to,
        cc: cc || null,
        bcc: bcc || null,
        subject,
        body_html: bodyHtml || "",
        thread_id: threadId || null,
        in_reply_to: inReplyTo || null,
        references_header: references || null,
        scheduled_send_at: scheduledSendAt,
        status: "pending",
        contact_name: contactName || null,
        matched_contact_id: matchedContactId || null,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ scheduledEmail: data });
  } catch (error) {
    console.error("Schedule email error:", error);
    return NextResponse.json(
      { error: "Failed to schedule email" },
      { status: 500 }
    );
  }
}

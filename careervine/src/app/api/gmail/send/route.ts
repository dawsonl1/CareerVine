import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getConnection } from "@/lib/gmail";

/**
 * POST /api/gmail/send
 * Sends an email through the user's connected Gmail account.
 * After sending, immediately caches the sent message metadata so it
 * appears in the UI without waiting for a full sync.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { to, cc, bcc, subject, bodyHtml, threadId, inReplyTo, references } = await request.json();

    if (!to || !subject) {
      return NextResponse.json({ error: "to and subject are required" }, { status: 400 });
    }

    const result = await sendEmail(user.id, {
      to, cc, bcc, subject,
      bodyHtml: bodyHtml || "",
      threadId, inReplyTo, references,
    });

    // Immediately cache the sent message metadata so it shows up without a full sync.
    // Match it to a contact if the recipient email is on file.
    const service = createSupabaseServiceClient();
    const conn = await getConnection(user.id);

    const toAddr = to.trim().toLowerCase();

    // Find a contact that owns this email address and belongs to the current user
    const { data: matchedRows } = await service
      .from("contact_emails")
      .select("contact_id, contacts!inner(user_id)")
      .eq("email", toAddr)
      .eq("contacts.user_id", user.id)
      .limit(1);
    const matchedContactId = matchedRows?.[0]?.contact_id || null;

    await service.from("email_messages").upsert(
      {
        user_id: user.id,
        gmail_message_id: result.messageId,
        thread_id: result.threadId || null,
        subject: subject,
        snippet: bodyHtml ? bodyHtml.replace(/<[^>]*>/g, "").slice(0, 200) : null,
        from_address: conn?.gmail_address?.toLowerCase() || "",
        to_addresses: [toAddr],
        date: new Date().toISOString(),
        label_ids: ["SENT"],
        is_read: true,
        direction: "outbound",
        matched_contact_id: matchedContactId,
      },
      { onConflict: "user_id,gmail_message_id", ignoreDuplicates: false }
    );

    return NextResponse.json({ success: true, messageId: result.messageId, threadId: result.threadId });
  } catch (error) {
    console.error("Gmail send error:", error);
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500 }
    );
  }
}

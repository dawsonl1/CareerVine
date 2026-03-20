import { withApiHandler } from "@/lib/api-handler";
import { gmailSendSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getConnection } from "@/lib/gmail";
import { EmailDirection, GmailLabel } from "@/lib/constants";

/**
 * POST /api/gmail/send
 * Sends an email through the user's connected Gmail account.
 * After sending, immediately caches the sent message metadata so it
 * appears in the UI without waiting for a full sync.
 */
export const POST = withApiHandler({
  schema: gmailSendSchema,
  handler: async ({ user, body }) => {
    const { to, cc, bcc, subject, bodyHtml, threadId, inReplyTo, references } = body;

    const result = await sendEmail(user.id, {
      to, cc, bcc, subject,
      bodyHtml: bodyHtml || "",
      threadId, inReplyTo, references,
    });

    // Immediately cache the sent message metadata so it shows up without a full sync.
    // Match it to a contact if the recipient email is on file.
    const service = createSupabaseServiceClient();
    const toAddr = to.trim().toLowerCase();

    // Fetch connection info and contact match in parallel
    const [conn, { data: matchedRows }] = await Promise.all([
      getConnection(user.id),
      service
        .from("contact_emails")
        .select("contact_id, contacts!inner(user_id)")
        .eq("email", toAddr)
        .eq("contacts.user_id", user.id)
        .limit(1),
    ]);
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
        label_ids: [GmailLabel.Sent],
        is_read: true,
        direction: EmailDirection.Outbound,
        matched_contact_id: matchedContactId,
      },
      { onConflict: "user_id,gmail_message_id", ignoreDuplicates: false }
    );

    return { success: true, messageId: result.messageId, threadId: result.threadId };
  },
});

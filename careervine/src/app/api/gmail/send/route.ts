import { withApiHandler } from "@/lib/api-handler";
import { gmailSendSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getConnection } from "@/lib/gmail";
import { EmailDirection, GmailLabel } from "@/lib/constants";
import { ONBOARDING_CONTACT_EMAIL } from "@/components/onboarding/onboarding-steps";

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

    if (toAddr === ONBOARDING_CONTACT_EMAIL) {
      // Check if this is the first email to Dawson from this user
      const { data: onboarding } = await service
        .from("user_onboarding")
        .select("current_step")
        .eq("user_id", user.id)
        .single();

      if (onboarding && onboarding.current_step === "compose_send_email") {
        // Insert simulated reply with a future timestamp so it sorts to top of inbox
        const replyDate = new Date(Date.now() + 5000);
        await service.from("email_messages").insert({
          user_id: user.id,
          gmail_message_id: `simulated-reply-${Date.now()}`,
          thread_id: result.threadId || null,
          subject: `Re: ${subject}`,
          snippet:
            "Hey! Thanks for reaching out — welcome to CareerVine. I built this to help people like you stay on top of their network.",
          from_address: ONBOARDING_CONTACT_EMAIL,
          to_addresses: [conn?.gmail_address?.toLowerCase() || ""],
          date: replyDate.toISOString(),
          label_ids: [GmailLabel.Inbox],
          is_read: false,
          direction: EmailDirection.Inbound,
          matched_contact_id: matchedContactId,
          is_simulated: true,
        });

        // Note: follow-up cancellation for onboarding emails is handled by the
        // cron processor which detects the simulated inbound reply in the thread.
      }
    }

    return { success: true, messageId: result.messageId, threadId: result.threadId };
  },
});

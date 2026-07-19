import { withApiHandler } from "@/lib/api-handler";
import { gmailDraftSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { insertEmailDraft } from "@/lib/data/emails";
import {
  loadContactEmploymentMap,
  resolveEmailsToContactIds,
  type ContactEmployment,
} from "@/lib/contact-employment";

/**
 * GET /api/gmail/drafts
 * Returns all drafts for the current user, ordered by most recently updated.
 * CAR-127: each draft is enriched with matched_contact_id + contactDetails for
 * Outreach recipient lines (live from contact_companies, not denormalized).
 */
export const GET = withApiHandler({
  authOptional: true,
  handler: async ({ user }) => {
    if (!user) return { drafts: [], contactDetails: {} as Record<number, ContactEmployment> };
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("email_drafts")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    const draftsRaw = data || [];

    const emailToContact = await resolveEmailsToContactIds(
      service,
      user.id,
      draftsRaw.map((d: { recipient_email?: string | null }) => d.recipient_email),
    );

    const drafts = draftsRaw.map((d: { recipient_email?: string | null }) => {
      const matched =
        (d.recipient_email && emailToContact.get(d.recipient_email.toLowerCase())) || null;
      return { ...d, matched_contact_id: matched };
    });

    const ids = drafts
      .map((d: { matched_contact_id?: number | null }) => d.matched_contact_id)
      .filter((id: number | null | undefined): id is number => id != null);

    const contactDetails = await loadContactEmploymentMap(service, user.id, ids);

    return { drafts, contactDetails };
  },
});

/**
 * POST /api/gmail/drafts
 * Create or update a draft. If body includes `id`, update that draft; otherwise create new.
 */
export const POST = withApiHandler({
  schema: gmailDraftSchema,
  handler: async ({ user, body }) => {
    const service = createSupabaseServiceClient();

    const draftData = {
      user_id: user.id,
      recipient_email: body.to || null,
      cc: body.cc || null,
      bcc: body.bcc || null,
      subject: body.subject || null,
      body_html: body.bodyHtml || null,
      thread_id: body.threadId || null,
      in_reply_to: body.inReplyTo || null,
      references_header: body.references || null,
      contact_name: body.contactName || null,
    };

    if (body.id) {
      // Update existing draft
      const { data, error } = await service
        .from("email_drafts")
        .update({ ...draftData, updated_at: new Date().toISOString() })
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select()
        .single();
      if (error) throw error;
      return { success: true, draft: data };
    } else {
      // Create new draft — shared insert (CAR-151): same rows the MCP
      // free-tier create_email_draft fallback writes.
      const data = await insertEmailDraft(service, user.id, {
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        threadId: body.threadId,
        inReplyTo: body.inReplyTo,
        references: body.references,
        contactName: body.contactName,
      });
      return { success: true, draft: data };
    }
  },
});

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailScheduleUpdateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus } from "@/lib/constants";
import { cancelScheduledEmailCascade } from "@/lib/data/emails";

/**
 * PUT /api/gmail/schedule/[id]
 * Updates a pending scheduled email.
 */
export const PUT = withApiHandler({
  schema: gmailScheduleUpdateSchema,
  handler: async ({ user, body, params }) => {
    const emailId = parseInt(params.id, 10);
    if (isNaN(emailId)) {
      throw new ApiError("Invalid ID", 400);
    }

    const service = createSupabaseServiceClient();

    const { data: existing } = await service
      .from("scheduled_emails")
      .select("id, user_id")
      .eq("id", emailId)
      .single();

    if (!existing || existing.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.to !== undefined) updates.recipient_email = body.to;
    if (body.cc !== undefined) updates.cc = body.cc || null;
    if (body.bcc !== undefined) updates.bcc = body.bcc || null;
    if (body.subject !== undefined) updates.subject = body.subject;
    if (body.bodyHtml !== undefined) updates.body_html = body.bodyHtml;
    if (body.scheduledSendAt !== undefined) updates.scheduled_send_at = body.scheduledSendAt;

    // Pending-only enforced inside the UPDATE itself (CAR-134): a read-then-
    // write guard races the send drivers — the row can be claimed and sent
    // between the check and the write.
    // cas-checked: `updates` is built from body fields above (to/cc/bcc/subject/
    // body_html/scheduled_send_at) and never includes `status`, so the filtered
    // column is not a written column and the .select() readback is sound.
    const { data, error } = await service
      .from("scheduled_emails")
      .update(updates)
      .eq("id", emailId)
      .eq("status", ScheduledEmailStatus.Pending)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new ApiError("Can only edit pending emails", 400);
    }

    return { scheduledEmail: data[0] };
  },
});

/**
 * DELETE /api/gmail/schedule/[id]
 * Cancels a pending scheduled email and any linked follow-ups.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const emailId = parseInt(params.id, 10);
    if (isNaN(emailId)) {
      throw new ApiError("Invalid ID", 400);
    }

    const service = createSupabaseServiceClient();

    const { data: existing } = await service
      .from("scheduled_emails")
      .select("id, user_id")
      .eq("id", emailId)
      .single();

    if (!existing || existing.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    // Atomic pending|failed → cancelled CAS + linked follow-up teardown,
    // shared with the MCP cancel_scheduled tool (CAR-134/CAR-136/CAR-151).
    const cancelled = await cancelScheduledEmailCascade(service, user.id, emailId);
    if (!cancelled) {
      throw new ApiError("This email is already sending or was sent.", 409);
    }

    return { success: true };
  },
});

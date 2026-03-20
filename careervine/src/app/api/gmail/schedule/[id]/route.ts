import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailScheduleUpdateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus, FollowUpStatus, FollowUpMessageStatus } from "@/lib/constants";

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
      .select("id, user_id, status")
      .eq("id", emailId)
      .single();

    if (!existing || existing.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }
    if (existing.status !== ScheduledEmailStatus.Pending) {
      throw new ApiError("Can only edit pending emails", 400);
    }

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

    return { scheduledEmail: data };
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

    const now = new Date().toISOString();

    // Cancel linked follow-ups
    const { data: linkedFollowUps } = await service
      .from("email_follow_ups")
      .select("id")
      .eq("scheduled_email_id", emailId)
      .eq("status", FollowUpStatus.Active);

    if (linkedFollowUps && linkedFollowUps.length > 0) {
      const fuIds = linkedFollowUps.map((fu) => fu.id);
      await service
        .from("email_follow_up_messages")
        .update({ status: FollowUpMessageStatus.Cancelled })
        .in("follow_up_id", fuIds)
        .eq("status", FollowUpMessageStatus.Pending);

      await service
        .from("email_follow_ups")
        .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
        .in("id", fuIds);
    }

    // Cancel the scheduled email
    await service
      .from("scheduled_emails")
      .update({ status: ScheduledEmailStatus.Cancelled, updated_at: now })
      .eq("id", emailId);

    return { success: true };
  },
});

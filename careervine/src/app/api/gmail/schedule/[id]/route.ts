import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailScheduleUpdateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus, FollowUpStatus, FollowUpMessageStatus, UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES } from "@/lib/constants";

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
    // between the check and the write. Status is not modified here, so
    // .select() is safe (no rule-17 trap).
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

    const now = new Date().toISOString();

    // Cancel the scheduled email first, atomically (CAR-134): only a row that
    // is still waiting (pending) or dead (failed) can be cancelled. A row a
    // send driver has claimed ('sending') or already sent must not flip to
    // cancelled — the mark-sent write is guarded on 'sending' and would be
    // stomped. count, not .select(): the update writes the filtered column
    // (rule 17).
    const { count: cancelled } = await service
      .from("scheduled_emails")
      .update(
        { status: ScheduledEmailStatus.Cancelled, updated_at: now },
        { count: "exact" },
      )
      .eq("id", emailId)
      .in("status", [ScheduledEmailStatus.Pending, ScheduledEmailStatus.Failed]);

    if (!cancelled) {
      throw new ApiError("This email is already sending or was sent.", 409);
    }

    // Cancel linked follow-ups (only after the cancel actually landed)
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
        // Include expired so a still-sendable expired sibling isn't orphaned when
        // its parent scheduled email is cancelled (CAR-105).
        .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);

      await service
        .from("email_follow_ups")
        .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
        .in("id", fuIds);
    }

    return { success: true };
  },
});

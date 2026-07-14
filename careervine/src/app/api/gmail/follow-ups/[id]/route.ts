import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailFollowUpUpdateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  buildFollowUpMessageRows,
  reconcileFollowUpEditStatuses,
  type PriorFollowUpMessageSnapshot,
} from "@/lib/follow-up-helpers";
import {
  FollowUpStatus,
  FollowUpMessageStatus,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";

/**
 * PUT /api/gmail/follow-ups/[id]
 * Updates the open messages in a follow-up sequence.
 * Deletes unresolved messages (pending + awaiting_review + expired) and replaces
 * them. Content-preserving edits of awaiting_review/expired steps keep that
 * status + park metadata so Send now still works (CAR-125).
 */
export const PUT = withApiHandler({
  schema: gmailFollowUpUpdateSchema,
  handler: async ({ user, body, params }) => {
    const followUpId = parseInt(params.id, 10);
    if (isNaN(followUpId)) {
      throw new ApiError("Invalid follow-up ID", 400);
    }

    const service = createSupabaseServiceClient();

    // Verify ownership and get original_sent_at
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("*")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    if (followUp.status !== FollowUpStatus.Active) {
      throw new ApiError("Can only edit active follow-ups", 400);
    }

    const { messages } = body;

    // Snapshot unresolved steps before rebuild so we can preserve review state.
    const { data: priorOpen } = await service
      .from("email_follow_up_messages")
      .select(
        "sequence_number, send_after_days, status, parked_at, expires_at, reminder_count, last_reminder_at, seen_during_window",
      )
      .eq("follow_up_id", followUpId)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);

    const priorBySequence = new Map<number, PriorFollowUpMessageSnapshot>();
    for (const row of priorOpen ?? []) {
      priorBySequence.set(row.sequence_number, row as PriorFollowUpMessageSnapshot);
    }

    // Delete all unresolved messages (includes expired) before rebuilding.
    await service
      .from("email_follow_up_messages")
      .delete()
      .eq("follow_up_id", followUpId)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);

    // Count already-sent messages to offset sequence numbers
    const { count: sentCount } = await service
      .from("email_follow_up_messages")
      .select("id", { count: "exact", head: true })
      .eq("follow_up_id", followUpId);

    // Insert new messages with sequence numbers after any already-sent ones
    const msgRows = reconcileFollowUpEditStatuses(
      buildFollowUpMessageRows(
        followUpId,
        messages,
        new Date(followUp.original_sent_at),
        sentCount ?? 0,
      ),
      priorBySequence,
    );

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

    return { followUp: complete };
  },
});

/**
 * DELETE /api/gmail/follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const followUpId = parseInt(params.id, 10);
    if (isNaN(followUpId)) {
      throw new ApiError("Invalid follow-up ID", 400);
    }

    const service = createSupabaseServiceClient();

    // Verify ownership
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("id, user_id")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    // Cancel every unresolved message (pending + awaiting_review + expired) so no
    // sendable orphan remains under a cancelled parent (CAR-105).
    await service
      .from("email_follow_up_messages")
      .update({ status: FollowUpMessageStatus.Cancelled })
      .eq("follow_up_id", followUpId)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);

    const now = new Date().toISOString();
    await service
      .from("email_follow_ups")
      .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
      .eq("id", followUpId);

    return { success: true };
  },
});

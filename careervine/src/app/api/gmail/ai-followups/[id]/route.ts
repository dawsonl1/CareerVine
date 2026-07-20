/**
 * PATCH /api/gmail/ai-followups/[id]
 *
 * Update an AI follow-up draft: dismiss, edit content, or toggle reply mode.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { aiFollowUpPatchSchema, idParamSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { AiFollowUpDraftStatus } from "@/lib/constants";

export const PATCH = withApiHandler({
  schema: aiFollowUpPatchSchema,
  paramsSchema: idParamSchema,
  handler: async ({ user, body, params, track }) => {
    const draftId = params.id;

    const service = createSupabaseServiceClient();

    // Verify ownership
    const { data: draft } = await service
      .from("ai_follow_up_drafts")
      .select("id, user_id, status")
      .eq("id", draftId)
      .single();

    if (!draft || draft.user_id !== user.id) {
      throw new ApiError("Draft not found", 404);
    }

    // Build update payload
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.status !== undefined) {
      // Prevent reverting a sent draft back to pending
      if (
        body.status === AiFollowUpDraftStatus.Pending &&
        (draft.status === AiFollowUpDraftStatus.Sent || draft.status === AiFollowUpDraftStatus.EditedAndSent)
      ) {
        throw new ApiError("Cannot modify a sent draft", 400);
      }

      update.status = body.status;
      if (body.status === AiFollowUpDraftStatus.Dismissed) {
        update.dismissed_at = new Date().toISOString();
      } else if (body.status === AiFollowUpDraftStatus.Sent || body.status === AiFollowUpDraftStatus.EditedAndSent) {
        update.sent_at = new Date().toISOString();
      } else if (body.status === AiFollowUpDraftStatus.Pending) {
        // Clear stale timestamps when reverting to pending (undo flow)
        update.dismissed_at = null;
        update.sent_at = null;
      }
    }

    if (body.subject !== undefined) update.subject = body.subject;
    if (body.bodyHtml !== undefined) update.body_html = body.bodyHtml;
    if (body.sendAsReply !== undefined) update.send_as_reply = body.sendAsReply;

    // cas-checked: `update` may carry `status`, but the only filter is `id`, so
    // no written column is re-tested and the .select() readback is sound.
    const { data: updated, error } = await service
      .from("ai_follow_up_drafts")
      .update(update)
      .eq("id", draftId)
      .select("id, status, updated_at")
      .single();

    if (error) throw error;

    // AI acceptance trio (CAR-38): terminal draft statuses map onto outcomes.
    if (body.status === AiFollowUpDraftStatus.Sent) {
      track("ai_draft_outcome", { outcome: "sent", edit_ratio: 1, kind: "follow_up" });
    } else if (body.status === AiFollowUpDraftStatus.EditedAndSent) {
      track("ai_draft_outcome", {
        outcome: "edited",
        kind: "follow_up",
        ...(body.editRatio !== undefined ? { edit_ratio: body.editRatio } : {}),
      });
    } else if (body.status === AiFollowUpDraftStatus.Dismissed) {
      track("ai_draft_outcome", { outcome: "discarded", kind: "follow_up" });
    }

    return { success: true, draft: updated };
  },
});

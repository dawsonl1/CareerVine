/**
 * PATCH /api/gmail/ai-followups/[id]
 *
 * Update an AI follow-up draft: dismiss, edit content, or toggle reply mode.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { aiFollowUpPatchSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { AiFollowUpDraftStatus } from "@/lib/constants";

export const PATCH = withApiHandler({
  schema: aiFollowUpPatchSchema,
  handler: async ({ user, body, params }) => {
    const draftId = Number(params.id);
    if (isNaN(draftId)) throw new ApiError("Invalid draft ID", 400);

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

    const { data: updated, error } = await service
      .from("ai_follow_up_drafts")
      .update(update)
      .eq("id", draftId)
      .select("id, status, updated_at")
      .single();

    if (error) throw error;

    return { success: true, draft: updated };
  },
});

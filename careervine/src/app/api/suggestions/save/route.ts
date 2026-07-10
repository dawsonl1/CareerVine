import { withApiHandler } from "@/lib/api-handler";
import { suggestionsSaveSchema } from "@/lib/api-schemas";
import { ActionItemSource, ChangeEventStatus } from "@/lib/constants";
import { createActionItem } from "@/lib/queries";
import { invalidateSuggestionCache } from "@/lib/ai-followup/generate-suggestions";
import { markChangeEventStatus } from "@/lib/change-events/change-events";

export const POST = withApiHandler({
  schema: suggestionsSaveSchema,
  handler: async ({ user, supabase, body }) => {
    const now = new Date().toISOString();
    const actionItem = await createActionItem(
      {
        user_id: user.id,
        contact_id: body.contactId,
        meeting_id: null,
        title: body.title,
        description: body.description || null,
        due_at: null,
        is_completed: !!body.completed,
        created_at: now,
        completed_at: body.completed ? now : null,
        source: ActionItemSource.AiSuggestion,
        suggestion_reason_type: body.reasonType,
        suggestion_headline: body.headline,
        suggestion_evidence: body.evidence,
      },
      [body.contactId],
      supabase,
    );

    // Invalidate cached suggestions so dedup picks up the new item
    invalidateSuggestionCache(user.id);

    // If this suggestion was backed by a persisted change event, mark it actioned
    // so it stops surfacing (plan 29).
    if (body.changeEventId != null) {
      await markChangeEventStatus(body.changeEventId, user.id, ChangeEventStatus.Actioned);
    }

    return { success: true, actionItem };
  },
});

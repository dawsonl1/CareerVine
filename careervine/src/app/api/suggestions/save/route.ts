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

    // Ordered before createActionItem deliberately (CAR-204). markChangeEventStatus
    // throws on a failed update as of CAR-188, and it used to run last — so a DB
    // error there aborted the route with a 500 AFTER the action item had already
    // committed, orphaning it. The client reads the 500 as "save failed", the user
    // retries, and createActionItem has no idempotency, so every retry adds another
    // row. Marking the event first means the only write that can fail is the first
    // one, and a failure leaves nothing behind.
    if (body.changeEventId != null) {
      await markChangeEventStatus(body.changeEventId, user.id, ChangeEventStatus.Actioned);
    }

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

    return { success: true, actionItem };
  },
});

import { withApiHandler } from "@/lib/api-handler";
import { suggestionsSaveSchema } from "@/lib/api-schemas";
import { ActionItemSource } from "@/lib/constants";
import { createActionItem } from "@/lib/queries";
import { invalidateSuggestionCache } from "@/lib/ai-followup/generate-suggestions";

export const POST = withApiHandler({
  schema: suggestionsSaveSchema,
  handler: async ({ user, supabase, body }) => {
    const actionItem = await createActionItem(
      {
        user_id: user.id,
        contact_id: body.contactId,
        title: body.title,
        description: body.description || null,
        due_at: null,
        is_completed: false,
        created_at: new Date().toISOString(),
        completed_at: null,
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

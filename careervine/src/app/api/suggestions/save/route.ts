import { withApiHandler } from "@/lib/api-handler";
import { suggestionsSaveSchema } from "@/lib/api-schemas";
import { ActionItemSource } from "@/lib/constants";

export const POST = withApiHandler({
  schema: suggestionsSaveSchema,
  handler: async ({ user, supabase, body }) => {
    // Create the action item
    const { data: actionItem, error } = await supabase
      .from("follow_up_action_items")
      .insert({
        user_id: user.id,
        contact_id: body.contactId,
        title: body.title,
        description: body.description || null,
        due_at: null,
        is_completed: false,
        created_at: new Date().toISOString(),
        completed_at: null,
        priority: null,
        source: ActionItemSource.AiSuggestion,
        suggestion_reason_type: body.reasonType,
        suggestion_headline: body.headline,
        suggestion_evidence: body.evidence,
      })
      .select()
      .single();

    if (error) throw error;

    // Insert junction row
    const { error: junctionError } = await supabase
      .from("action_item_contacts")
      .insert({ action_item_id: actionItem.id, contact_id: body.contactId });

    if (junctionError) throw junctionError;

    return { success: true, actionItem };
  },
});

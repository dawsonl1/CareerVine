import { withApiHandler } from "@/lib/api-handler";
import { generateSuggestions } from "@/lib/ai-followup/generate-suggestions";

export const POST = withApiHandler({
  handler: async ({ user }) => {
    const { suggestions, aiStatus } = await generateSuggestions(user.id);
    // aiStatus is set only when the LLM pass couldn't run for lack of a usable
    // key — the client shows a quiet prompt; rule-based suggestions still return.
    return { success: true, suggestions, aiStatus };
  },
});

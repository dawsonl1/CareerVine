import { withApiHandler } from "@/lib/api-handler";
import { generateSuggestions } from "@/lib/ai-followup/generate-suggestions";

export const POST = withApiHandler({
  handler: async ({ user }) => {
    const suggestions = await generateSuggestions(user.id);
    return { success: true, suggestions };
  },
});

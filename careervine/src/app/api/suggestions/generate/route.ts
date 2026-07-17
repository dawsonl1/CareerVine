import { withApiHandler } from "@/lib/api-handler";
import { generateSuggestions } from "@/lib/ai-followup/generate-suggestions";

export const POST = withApiHandler({
  // Modest per-user cap (CAR-149): the LLM pass fronts spend. Not fail-closed —
  // it degrades to rule-based suggestions, so a limiter outage shouldn't block it.
  rateLimit: { bucket: "suggestions-generate", limit: 60, window: "1 h" },
  handler: async ({ user }) => {
    const { suggestions, aiStatus } = await generateSuggestions(user.id);
    // aiStatus is set only when the LLM pass couldn't run for lack of a usable
    // key — the client shows a quiet prompt; rule-based suggestions still return.
    return { success: true, suggestions, aiStatus };
  },
});

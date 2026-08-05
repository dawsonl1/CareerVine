import { z } from "zod";
import { withApiHandler } from "@/lib/api-handler";
import { generateSuggestions, invalidateSuggestionCache } from "@/lib/ai-followup/generate-suggestions";

/**
 * Body schema. NOTE: declaring one makes a JSON body REQUIRED — `withApiHandler`
 * 400s a POST it cannot parse, before the handler runs. The Up Next feed is the
 * only caller and always sends one; a new caller must too.
 */
const suggestionsGenerateSchema = z.object({
  /**
   * Explicit user-driven refresh (the retry banner), as opposed to the
   * background regeneration a page mount schedules.
   *
   * `generateSuggestions` memoizes its result per user for 60s, so without this
   * a retry inside that window returns the byte-identical result and the button
   * lies about having done anything.
   */
  force: z.boolean().optional(),
});

/**
 * Regenerates the ephemeral AI suggestion set.
 *
 * This is the expensive half of the Up Next feed and it does not get cheaper:
 * `generateSuggestions` fans out roughly two dozen Supabase reads at a
 * serial depth of six (contacts → interactions/meetings → contact emails →
 * five parallel per-contact context gathers, each of which is itself three
 * or four dependent queries), and then makes one OpenAI structured-output
 * call over a prompt assembled from up to five contacts' full meeting notes
 * and transcript excerpts. It measured 6,291ms in production and was the
 * single reason /action-items took 6.9s to data-ready (CAR-229).
 *
 * So the fix is not here — it is that nothing waits on this any more. The feed
 * paints from `/api/change-events` plus its own cache of the last result, and
 * only calls this route when that cache has gone stale. The gate, its windows,
 * and why they are what they are live in `src/hooks/use-suggestions.ts`.
 */
export const POST = withApiHandler({
  // Modest per-user cap (CAR-149): the LLM pass fronts spend. Not fail-closed —
  // an unset Upstash fails open (the route still returns rule-based suggestions)
  // rather than denying. (A transient Upstash error still surfaces as a 500,
  // same as every non-failClosed bucket — the cap is abuse-limiting, not a
  // hard spend gate here.)
  rateLimit: { bucket: "suggestions-generate", limit: 60, window: "1 h" },
  schema: suggestionsGenerateSchema,
  handler: async ({ user, body }) => {
    if (body.force) invalidateSuggestionCache(user.id);
    const { suggestions, aiStatus } = await generateSuggestions(user.id);
    // aiStatus is set only when the LLM pass couldn't run for lack of a usable
    // key — the client shows a quiet prompt; rule-based suggestions still return.
    return { success: true, suggestions, aiStatus };
  },
});

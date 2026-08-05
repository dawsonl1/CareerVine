import { createHash } from "crypto";
import { withApiHandler } from "@/lib/api-handler";
import { syncAnniversaryEvents, fetchChangeEventSuggestions } from "@/lib/change-events/change-events";

/**
 * An opaque, stable, per-user token used to namespace client-side caches.
 *
 * A digest rather than the raw id so nothing downstream is tempted to read it
 * as an identifier — it is only ever compared against itself.
 */
function cacheScopeFor(userId: string): string {
  return createHash("sha256").update(`suggestions:${userId}`).digest("hex").slice(0, 16);
}

/**
 * Returns the user's surfaceable change events (plan 29), mapped into the
 * Suggestion shape for the Up Next feed. Runs the lazy anniversary producer
 * first so opening the dashboard reconciles this month's anniversaries; the
 * upsert is idempotent, so this is cheap and safe to run on every load.
 *
 * This is also the FAST half of that feed: persisted rows behind an indexed
 * read, versus `/api/suggestions/generate`'s ~6s LLM pass. `useSuggestions`
 * paints from this alone and folds the AI half in whenever it arrives.
 *
 * `cacheScope` (CAR-229) rides along because this is the one request the feed
 * makes unconditionally on every mount, and the hook refuses to read its
 * localStorage cache of the last AI generation until the server has named the
 * scope. Deriving that key client-side would mean either painting before the
 * identity is known — one account seeing another's cards on a shared browser —
 * or pulling the auth context into a hook that deliberately has no provider
 * dependency.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    await syncAnniversaryEvents(user.id);
    const suggestions = await fetchChangeEventSuggestions(user.id);
    return { success: true, suggestions, cacheScope: cacheScopeFor(user.id) };
  },
});

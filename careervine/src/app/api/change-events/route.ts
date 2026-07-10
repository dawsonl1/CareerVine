import { withApiHandler } from "@/lib/api-handler";
import { syncAnniversaryEvents, fetchChangeEventSuggestions } from "@/lib/change-events/change-events";

/**
 * Returns the user's surfaceable change events (plan 29), mapped into the
 * Suggestion shape for the Up Next feed. Runs the lazy anniversary producer
 * first so opening the dashboard reconciles this month's anniversaries; the
 * upsert is idempotent, so this is cheap and safe to run on every load.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    await syncAnniversaryEvents(user.id);
    const suggestions = await fetchChangeEventSuggestions(user.id);
    return { success: true, suggestions };
  },
});

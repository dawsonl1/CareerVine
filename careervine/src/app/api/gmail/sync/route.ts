import { withApiHandler } from "@/lib/api-handler";
import { syncAllContactEmails, detectBounces } from "@/lib/gmail";

// The sync loop is one serial Gmail query per contact — give it the full
// allowance instead of the platform default, which kills it mid-pass.
export const maxDuration = 60;

/**
 * POST /api/gmail/sync
 * Runs one time-budgeted pass of the Gmail sync for the authenticated user.
 * Body (optional): { cursor: number } — resume token from a previous pass.
 * Returns nextCursor when more contacts remain; the client keeps calling
 * until it is null. Bounce detection runs only when a pass completes
 * (NDRs never match contacts by address, so the per-contact sync can't
 * see them).
 */
export const POST = withApiHandler({
  handler: async ({ user, request }) => {
    const raw = await request.json().catch(() => null);
    const cursor =
      raw && typeof raw.cursor === "number" && Number.isInteger(raw.cursor) && raw.cursor >= 0
        ? raw.cursor
        : undefined;

    const result = await syncAllContactEmails(user.id, 90, { cursor });

    let bounces: { bounced: string[]; cancelledSequences: number } = { bounced: [], cancelledSequences: 0 };
    if (result.nextCursor === null) {
      try {
        bounces = await detectBounces(user.id);
      } catch (err) {
        console.warn("[gmail/sync] Bounce detection failed:", err);
      }
    }

    return {
      success: true,
      totalSynced: result.totalSynced,
      processedContacts: result.processedContacts,
      failedContacts: result.failedContacts,
      nextCursor: result.nextCursor,
      bounced: bounces.bounced.length,
      cancelledSequences: bounces.cancelledSequences,
    };
  },
});

import { withApiHandler } from "@/lib/api-handler";
import { syncAllContactEmails, detectBounces, syncThreadReplies } from "@/lib/gmail";

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
  requireCapability: "mailbox:read",
  handler: async ({ user, request }) => {
    const raw = await request.json().catch(() => null);
    const cursor =
      raw && typeof raw.cursor === "number" && Number.isInteger(raw.cursor) && raw.cursor >= 0
        ? raw.cursor
        : undefined;

    const result = await syncAllContactEmails(user.id, 90, { cursor });

    let bounces: { bounced: string[]; cancelledSequences: number } = { bounced: [], cancelledSequences: 0 };
    // Replies from an address we do not have on the contact (CAR-227). Runs on
    // pass completion for the same reason bounce detection does: the
    // per-contact query is scoped to known addresses and cannot see either.
    let threadReplies = { ingested: 0, learnedAddresses: 0 };
    if (result.nextCursor === null) {
      try {
        threadReplies = await syncThreadReplies(user.id);
      } catch (err) {
        // Error-tolerated to match detectBounces beside it: the per-contact
        // sync above already succeeded, and failing the whole request here
        // would report a completed sync as broken.
        console.warn("[gmail/sync] Thread-reply sweep failed:", err);
      }
      try {
        bounces = await detectBounces(user.id);
      } catch (err) {
        console.warn("[gmail/sync] Bounce detection failed:", err);
      }
    }

    return {
      success: true,
      totalSynced: result.totalSynced + threadReplies.ingested,
      processedContacts: result.processedContacts,
      failedContacts: result.failedContacts,
      nextCursor: result.nextCursor,
      bounced: bounces.bounced.length,
      cancelledSequences: bounces.cancelledSequences,
      threadReplies: threadReplies.ingested,
      learnedAddresses: threadReplies.learnedAddresses,
    };
  },
});

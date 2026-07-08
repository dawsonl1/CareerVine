import { withApiHandler } from "@/lib/api-handler";
import { syncAllContactEmails, detectBounces } from "@/lib/gmail";

/**
 * POST /api/gmail/sync
 * Manually triggers a full Gmail sync for the authenticated user,
 * then a bounce-detection pass (NDRs never match contacts by address,
 * so the per-contact sync can't see them).
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const totalSynced = await syncAllContactEmails(user.id);

    let bounces: { bounced: string[]; cancelledSequences: number } = { bounced: [], cancelledSequences: 0 };
    try {
      bounces = await detectBounces(user.id);
    } catch (err) {
      console.warn("[gmail/sync] Bounce detection failed:", err);
    }

    return {
      success: true,
      totalSynced,
      bounced: bounces.bounced.length,
      cancelledSequences: bounces.cancelledSequences,
    };
  },
});

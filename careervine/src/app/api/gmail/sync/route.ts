import { withApiHandler } from "@/lib/api-handler";
import { syncAllContactEmails } from "@/lib/gmail";

/**
 * POST /api/gmail/sync
 * Manually triggers a full Gmail sync for the authenticated user.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const totalSynced = await syncAllContactEmails(user.id);
    return { success: true, totalSynced };
  },
});

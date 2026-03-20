import { withApiHandler } from "@/lib/api-handler";
import { revokeAccess } from "@/lib/gmail";

/**
 * POST /api/gmail/disconnect
 * Revokes the Google token and removes all Gmail data for the user.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    await revokeAccess(user.id);
    return { success: true };
  },
});

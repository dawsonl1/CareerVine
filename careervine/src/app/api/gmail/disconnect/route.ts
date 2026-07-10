import { withApiHandler } from "@/lib/api-handler";
import { revokeAccess } from "@/lib/gmail";

/**
 * POST /api/gmail/disconnect
 * Revokes the Google token and removes all Gmail data for the user.
 */
export const POST = withApiHandler({
  handler: async ({ user, track }) => {
    await revokeAccess(user.id);
    track("gmail_disconnected", {});
    return { success: true };
  },
});

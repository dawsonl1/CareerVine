import { withApiHandler } from "@/lib/api-handler";
import { getGmailLabels } from "@/lib/gmail";

/**
 * GET /api/gmail/labels
 * Returns the user's Gmail labels/folders for the "Move to" UI.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const labels = await getGmailLabels(user.id);
    return { labels };
  },
});

import { withApiHandler } from "@/lib/api-handler";
import { getGmailLabels } from "@/lib/gmail";

/**
 * GET /api/gmail/labels
 * Returns the user's Gmail labels/folders for the "Move to" UI. Live mailbox
 * read — premium only (CAR-102).
 */
export const GET = withApiHandler({
  requireCapability: "mailbox:read",
  handler: async ({ user }) => {
    const labels = await getGmailLabels(user.id);
    return { labels };
  },
});

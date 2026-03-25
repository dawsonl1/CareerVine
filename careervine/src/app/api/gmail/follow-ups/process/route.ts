import { withApiHandler } from "@/lib/api-handler";

/**
 * POST /api/gmail/follow-ups/process
 * DEPRECATED: Follow-up processing is now handled by the QStash cron
 * at /api/cron/send-follow-ups (runs every 15 minutes for all users).
 * This endpoint is kept for backwards compatibility but is a no-op.
 */
export const POST = withApiHandler({
  handler: async () => {
    return { success: true, sent: 0, cancelled: 0, errors: 0, message: "Processing handled by QStash cron" };
  },
});

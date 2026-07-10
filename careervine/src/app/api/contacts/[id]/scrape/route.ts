import { withApiHandler, ApiError } from "@/lib/api-handler";
import { scrapeContactSchema } from "@/lib/api-schemas";
import { triggerContactScrape } from "@/lib/apify/scrape-service";
import { ScrapeMode, ScrapeTrigger } from "@/lib/constants";

/**
 * POST /api/contacts/[id]/scrape
 * Trigger an on-demand Apify re-scrape / find-email for one contact (plan 29).
 * Returns immediately; the run completes asynchronously via the webhook
 * callback. Idempotent — an in-flight run for this contact returns "pending".
 */
export const maxDuration = 30;

export const POST = withApiHandler({
  schema: scrapeContactSchema,
  handler: async ({ user, params, body }) => {
    const contactId = Number(params.id);
    if (!Number.isFinite(contactId)) throw new ApiError("Invalid contact id", 400);

    const mode = body?.mode === "email" ? ScrapeMode.Email : ScrapeMode.Profile;
    const result = await triggerContactScrape({
      userId: user.id,
      contactId,
      mode,
      trigger: ScrapeTrigger.Manual,
    });
    return { success: true, ...result };
  },
});

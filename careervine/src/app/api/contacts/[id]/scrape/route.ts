import { withApiHandler } from "@/lib/api-handler";
import { scrapeContactSchema, idParamSchema } from "@/lib/api-schemas";
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
  paramsSchema: idParamSchema,
  // Modest per-user cap (CAR-149): each run can trigger Apify spend (also
  // ledger-capped). Not fail-closed — the cost ledger is the hard spend gate.
  rateLimit: { bucket: "contacts-scrape", limit: 30, window: "1 h" },
  handler: async ({ user, params, body }) => {
    const contactId = params.id;

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

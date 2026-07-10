import { withApiHandler, ApiError } from "@/lib/api-handler";
import { linkLinkedinSchema } from "@/lib/api-schemas";
import { linkContactLinkedin } from "@/lib/apify/resolver";

/**
 * POST /api/contacts/[id]/link-linkedin
 * Write a confirmed LinkedIn URL onto the contact (canonicalized, duplicate-
 * guarded) and kick an enrich scrape. The confirm step of the resolve flow;
 * also accepts a hand-pasted URL.
 */
export const POST = withApiHandler({
  schema: linkLinkedinSchema,
  handler: async ({ user, params, body }) => {
    const contactId = Number(params.id);
    if (!Number.isFinite(contactId)) throw new ApiError("Invalid contact id", 400);
    const result = await linkContactLinkedin(user.id, contactId, body.linkedinUrl);
    return { success: true, ...result };
  },
});

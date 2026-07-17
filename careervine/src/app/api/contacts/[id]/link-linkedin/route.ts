import { withApiHandler } from "@/lib/api-handler";
import { linkLinkedinSchema, idParamSchema } from "@/lib/api-schemas";
import { linkContactLinkedin } from "@/lib/apify/resolver";

/**
 * POST /api/contacts/[id]/link-linkedin
 * Write a confirmed LinkedIn URL onto the contact (canonicalized, duplicate-
 * guarded) and kick an enrich scrape. The confirm step of the resolve flow;
 * also accepts a hand-pasted URL.
 */
export const POST = withApiHandler({
  schema: linkLinkedinSchema,
  paramsSchema: idParamSchema,
  handler: async ({ user, params, body }) => {
    const contactId = params.id;
    const result = await linkContactLinkedin(user.id, contactId, body.linkedinUrl);
    return { success: true, ...result };
  },
});

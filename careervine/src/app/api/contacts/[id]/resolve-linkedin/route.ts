import { withApiHandler } from "@/lib/api-handler";
import { idParamSchema } from "@/lib/api-schemas";
import { resolveContactLinkedin } from "@/lib/apify/resolver";

/**
 * POST /api/contacts/[id]/resolve-linkedin
 * Search LinkedIn (actor B, short mode, one page) for profiles matching this
 * contact's name, narrowed by their current company / location. Synchronous —
 * feeds the picker modal (plan 29 §6.3). $0.004 per search, ledgered.
 */
export const maxDuration = 60;

export const POST = withApiHandler({
  paramsSchema: idParamSchema,
  handler: async ({ user, params }) => {
    const contactId = params.id;
    const result = await resolveContactLinkedin(user.id, contactId);
    return { success: true, ...result };
  },
});

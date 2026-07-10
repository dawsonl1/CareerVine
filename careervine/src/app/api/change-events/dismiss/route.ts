import { withApiHandler } from "@/lib/api-handler";
import { changeEventDismissSchema } from "@/lib/api-schemas";
import { ChangeEventStatus } from "@/lib/constants";
import { markChangeEventStatus } from "@/lib/change-events/change-events";

/**
 * Dismiss a change event so it never surfaces again (plan 29). The row persists
 * with status='dismissed', and the idempotent producer will not revive it.
 */
export const POST = withApiHandler({
  schema: changeEventDismissSchema,
  handler: async ({ user, body }) => {
    await markChangeEventStatus(body.changeEventId, user.id, ChangeEventStatus.Dismissed);
    return { success: true };
  },
});

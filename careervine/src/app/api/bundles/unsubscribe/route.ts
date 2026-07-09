/**
 * POST /api/bundles/unsubscribe — end a bundle subscription.
 *
 * keepAll=true keeps every imported contact (linkage dropped); false
 * removes bundle-created contacts the user never touched, keeping
 * anything edited/tagged/contacted or supplied by another subscription.
 * Cursor-looped by the client for large subscriptions.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { bundleUnsubscribeSchema } from "@/lib/api-schemas";
import { unsubscribeFromBundle } from "@/lib/bundle-sync";

export const maxDuration = 60;

export const POST = withApiHandler({
  schema: bundleUnsubscribeSchema,
  handler: async ({ supabase, user, body }) => {
    const input = body as { bundleId: number; keepAll: boolean; cursor?: number | null };

    const { data: subRow } = await supabase
      .from("bundle_subscriptions")
      .select("id, user_id, bundle_id, status, synced_version")
      .eq("user_id", user.id)
      .eq("bundle_id", input.bundleId)
      .maybeSingle();
    if (!subRow) throw new ApiError("Not subscribed to this bundle", 404);

    return await unsubscribeFromBundle(
      supabase,
      subRow as { id: number; user_id: string; bundle_id: number; status: string; synced_version: number },
      { keepAll: input.keepAll, cursor: input.cursor },
    );
  },
});

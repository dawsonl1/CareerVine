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
import { enqueueBundleSyncJobs } from "@/lib/bundle-queue";

export const maxDuration = 60;

/** Backup cleanup driver (CAR-53), mirroring the subscribe-side backup: if
 * the client's cursor loop dies mid-removal, the worker resumes it from the
 * persisted unsubscribe_keep_all intent. Same claim-window rationale as
 * subscribe's delay; the daily cron sweep is the net behind this net. */
const UNSUBSCRIBE_BACKUP_DELAY_S = 180;

export const POST = withApiHandler({
  schema: bundleUnsubscribeSchema,
  handler: async ({ supabase, user, body, track, request }) => {
    const input = body as { bundleId: number; keepAll: boolean; cursor?: number | null };

    const { data: subRow } = await supabase
      .from("bundle_subscriptions")
      .select("id, user_id, bundle_id, status, synced_version")
      .eq("user_id", user.id)
      .eq("bundle_id", input.bundleId)
      .maybeSingle();
    if (!subRow) throw new ApiError("Not subscribed to this bundle", 404);
    const subscription = subRow as {
      id: number;
      user_id: string;
      bundle_id: number;
      status: string;
      synced_version: number;
    };

    const result = await unsubscribeFromBundle(supabase, subscription, {
      keepAll: input.keepAll,
      cursor: input.cursor,
    });
    // Cursor-looped: only the first chunk records the decision + backup job.
    if (input.cursor == null) {
      if (!result.done) {
        await enqueueBundleSyncJobs(
          [subscription.id],
          new URL("/api/queue/bundle-sync", request.url).toString(),
          undefined,
          { delaySeconds: UNSUBSCRIBE_BACKUP_DELAY_S },
        );
      }
      track("bundle_unsubscribed", { bundle_id: String(input.bundleId) });
    }
    return result;
  },
});

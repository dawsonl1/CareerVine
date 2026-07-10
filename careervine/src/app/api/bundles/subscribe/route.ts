/**
 * POST /api/bundles/subscribe — create or reactivate a bundle subscription.
 *
 * No import work happens here: the client (or the QStash worker/cron)
 * drives the actual copy through /api/bundles/apply in cursor chunks.
 * Resubscribing resets synced_version to 0, forcing a full re-apply —
 * safe because the merge engine is idempotent.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { bundleSubscribeSchema } from "@/lib/api-schemas";
import { enqueueBundleSyncJobs } from "@/lib/bundle-queue";

/**
 * Backup sync driver (CAR-47): the client drives the initial copy
 * interactively, but if the tab closes or its loop dies, this delayed
 * QStash job finishes the sync instead of waiting for the daily cron.
 * The delay gives the client's loop first claim; a still-running or
 * already-finished sync makes the worker a no-op (claim conflict /
 * synced_version current). Fails silent when QStash isn't configured.
 *
 * MUST stay above SYNC_CLAIM_MS (2 min): a timeout-killed apply call
 * never releases its claim, and a backup firing inside that window
 * would be skipped against a zombie claim. The worker also re-enqueues
 * skipped ids after the claim window as a second net.
 */
const SUBSCRIBE_BACKUP_SYNC_DELAY_S = 180;

export const POST = withApiHandler({
  schema: bundleSubscribeSchema,
  handler: async ({ supabase, user, body, track, request }) => {
    const { bundleId } = body as { bundleId: number };

    // Never throws: enqueueBundleSyncJobs catches per-batch and returns a
    // count; without QSTASH_TOKEN it returns 0.
    const enqueueBackupSync = (subscriptionId: number) =>
      enqueueBundleSyncJobs(
        [subscriptionId],
        new URL("/api/queue/bundle-sync", request.url).toString(),
        undefined,
        { delaySeconds: SUBSCRIBE_BACKUP_SYNC_DELAY_S },
      );

    // RLS only exposes published bundles — a null read means missing or
    // unpublished either way.
    const { data: bundle } = await supabase
      .from("data_bundles")
      .select("id, name, version, prospect_count")
      .eq("id", bundleId)
      .maybeSingle();
    if (!bundle) throw new ApiError("Bundle not found", 404);

    const { data: existing } = await supabase
      .from("bundle_subscriptions")
      .select("id, status, synced_version")
      .eq("user_id", user.id)
      .eq("bundle_id", bundleId)
      .maybeSingle();

    const nowIso = new Date().toISOString();
    if (existing) {
      const row = existing as { id: number; status: string; synced_version: number };
      if (row.status === "active") return { subscription: row, reactivated: false };
      const { data: updated, error } = await supabase
        .from("bundle_subscriptions")
        .update({
          status: "active",
          synced_version: 0,
          sync_claimed_until: null,
          // A fresh full re-apply starts from scratch: drop any stale sync
          // checkpoint and cancel a pending unsubscribe cleanup (the user
          // wants the data back — removing it now would be wrong).
          sync_cursor: null,
          unsubscribe_keep_all: null,
          updated_at: nowIso,
        })
        .eq("id", row.id)
        .select("id, status, synced_version")
        .single();
      if (error) throw new ApiError(`Resubscribe failed: ${error.message}`, 500);
      await enqueueBackupSync(row.id);
      track("bundle_subscribed", { bundle_id: String(bundleId) });
      return { subscription: updated, reactivated: true };
    }

    const { data: created, error } = await supabase
      .from("bundle_subscriptions")
      .insert({ user_id: user.id, bundle_id: bundleId })
      .select("id, status, synced_version")
      .single();
    if (error) throw new ApiError(`Subscribe failed: ${error.message}`, 500);
    await enqueueBackupSync((created as { id: number }).id);
    track("bundle_subscribed", { bundle_id: String(bundleId) });
    return { subscription: created, reactivated: false };
  },
});

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

export const POST = withApiHandler({
  schema: bundleSubscribeSchema,
  handler: async ({ supabase, user, body }) => {
    const { bundleId } = body as { bundleId: number };

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
        .update({ status: "active", synced_version: 0, sync_claimed_until: null, updated_at: nowIso })
        .eq("id", row.id)
        .select("id, status, synced_version")
        .single();
      if (error) throw new ApiError(`Resubscribe failed: ${error.message}`, 500);
      return { subscription: updated, reactivated: true };
    }

    const { data: created, error } = await supabase
      .from("bundle_subscriptions")
      .insert({ user_id: user.id, bundle_id: bundleId })
      .select("id, status, synced_version")
      .single();
    if (error) throw new ApiError(`Subscribe failed: ${error.message}`, 500);
    return { subscription: created, reactivated: false };
  },
});

/**
 * POST /api/bundles/apply — apply one cursor chunk of a bundle delta to
 * the caller's own subscription (RLS user client).
 *
 * The client loops until done, threading cursor + pinnedVersion +
 * claimToken through each call: the pin keeps the whole loop on one
 * committed bundle version even if a publish lands mid-loop, and the
 * claim keeps the background sync drivers from interleaving with it.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { bundleApplySchema } from "@/lib/api-schemas";
import {
  applyBundleDelta,
  claimSubscriptionSync,
  releaseSubscriptionSync,
  type ApplyCursor,
} from "@/lib/bundle-sync";

export const maxDuration = 60;

export const POST = withApiHandler({
  schema: bundleApplySchema,
  handler: async ({ supabase, user, body }) => {
    const input = body as {
      bundleId: number;
      cursor?: ApplyCursor | null;
      pinnedVersion?: number;
      claimToken?: string;
    };

    const { data: bundleRow } = await supabase
      .from("data_bundles")
      .select("id, slug, name, version, resolved_version")
      .eq("id", input.bundleId)
      .maybeSingle();
    if (!bundleRow) throw new ApiError("Bundle not found", 404);
    const bundle = bundleRow as {
      id: number;
      slug: string;
      name: string;
      version: number;
      resolved_version: number;
    };

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
    if (subscription.status !== "active") throw new ApiError("Subscription is not active", 409);

    const pinnedVersion = input.pinnedVersion ?? bundle.version;
    if (subscription.synced_version >= pinnedVersion) {
      return { done: true, applied: 0, removedContacts: 0, orphanedLinks: 0, skipped: [], pinnedVersion };
    }

    const claimToken = await claimSubscriptionSync(supabase, subscription.id, input.claimToken);
    if (!claimToken) throw new ApiError("A sync is already running for this subscription", 409);

    try {
      const step = await applyBundleDelta(supabase, subscription, bundle, {
        cursor: input.cursor ?? null,
        pinnedVersion,
      });
      if (step.done) {
        await releaseSubscriptionSync(supabase, subscription.id, claimToken);
        return step;
      }
      return { ...step, claimToken };
    } catch (err) {
      // Free the slot so the crash doesn't block the cron/fan-out drivers
      // for the full claim window.
      await releaseSubscriptionSync(supabase, subscription.id, claimToken).catch(() => {});
      throw err;
    }
  },
});

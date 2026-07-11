/**
 * POST /api/bundles/apply — apply a bundle delta to the caller's own
 * subscription (RLS user client).
 *
 * Since CAR-78 one call loops applyBundleDelta steps in-process under a
 * wall-clock budget instead of doing exactly one chunk, so a typical sync
 * finishes in 1–2 round trips instead of ~14. The request/response contract
 * is unchanged: the client still threads cursor + pinnedVersion + claimToken
 * through calls (the pin keeps the whole sync on one committed bundle version
 * even if a publish lands mid-loop, and the claim keeps the background sync
 * drivers from interleaving), and a budget-exhausted response hands back the
 * cursor exactly like a single-chunk response used to.
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

/** Stop starting new steps after this much wall clock (CAR-78). The margin to
 * maxDuration must absorb one worst-case step — the budget gates STARTING a
 * step, never interrupts one — so a step beginning at the budget edge still
 * has ~25s before the platform kills the function. */
const APPLY_LOOP_BUDGET_MS = 35_000;

export const POST = withApiHandler({
  schema: bundleApplySchema,
  handler: async ({ supabase, user, body, defer }) => {
    const startedAt = Date.now();
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

    let claimToken = await claimSubscriptionSync(supabase, subscription.id, input.claimToken);
    if (!claimToken) throw new ApiError("A sync is already running for this subscription", 409);

    // Sums across the in-process steps, so the client's progress totals keep
    // meaning "applied by this call" like they did when a call was one chunk.
    const totals = { applied: 0, removedContacts: 0, orphanedLinks: 0, skipped: [] as string[] };
    let cursor: ApplyCursor | null = input.cursor ?? null;

    try {
      for (;;) {
        const step = await applyBundleDelta(supabase, subscription, bundle, {
          cursor,
          pinnedVersion,
          // Analytics ride the api-handler's post-response flush instead of
          // blocking the sync (CAR-78).
          deferAnalytics: defer,
        });
        totals.applied += step.applied;
        totals.removedContacts += step.removedContacts;
        totals.orphanedLinks += step.orphanedLinks;
        totals.skipped.push(...step.skipped);

        if (step.done) {
          await releaseSubscriptionSync(supabase, subscription.id, claimToken);
          return { ...step, ...totals };
        }
        cursor = step.nextCursor;

        if (Date.now() - startedAt >= APPLY_LOOP_BUDGET_MS) {
          return { ...step, ...totals, claimToken };
        }
        // CAS-renew so the claim horizon stays a full window ahead of the
        // loop. A failed renewal means the token was released/stolen — stop
        // looping and let the next call sort it out rather than risk
        // interleaving with whoever holds it now.
        const renewed = await claimSubscriptionSync(supabase, subscription.id, claimToken);
        if (!renewed) {
          return { ...step, ...totals, claimToken };
        }
        claimToken = renewed;
      }
    } catch (err) {
      // Free the slot so the crash doesn't block the cron/fan-out drivers
      // for the full claim window.
      await releaseSubscriptionSync(supabase, subscription.id, claimToken).catch(() => {});
      throw err;
    }
  },
});

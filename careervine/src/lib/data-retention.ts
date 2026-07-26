import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/lib/database.types";
import { paginateAll } from "@/lib/data/postgrest";

/**
 * Retention purge for scraped third-party data (CAR-135 / R4.8).
 *
 * Two scraped-data stores accumulated third-party profile payloads with no
 * expiry:
 *
 *  - discovery_candidates: strangers surfaced by the weekly people-search.
 *    Once a candidate is added or dismissed its full payload is redacted at the
 *    transition (add/dismiss routes) and the ingest no longer rewrites it, so
 *    this job only removes STALE 'new' candidates — ones the weekly cron has
 *    stopped matching (they are no longer current new-hires), whose payload
 *    would otherwise linger forever.
 *  - bundle_prospects: CareerVine's curated catalog. Live prospects are the
 *    product's dataset and are kept; soft-removed prospects (removed_in_version
 *    set) are dead weight once every subscriber has synced past the removal.
 *
 * Deletes are terminal, so both steps are conservative: the bundle step never
 * deletes a soft-removed row any active subscriber still needs for its removal
 * delta (removed_in_version must be <= every active subscription's
 * synced_version for that bundle), and the discovery step only touches 'new'
 * rows older than the staleness window.
 */

/** Third-party fields cleared when a candidate is added/dismissed. raw is NOT
 *  NULL, so it is emptied to `{}` rather than nulled. Keeps the identity
 *  tombstone (user_id, linkedin_url, name, status) for dedup + sticky dismiss. */
export const REDACTED_CANDIDATE_FIELDS = {
  raw: {} as Json,
  headline: null,
  location: null,
  photo_url: null,
  position: null,
} as const;

/** 'new' discovery candidates not re-seen within this window are deleted. The
 *  discovery search itself only surfaces hires from the last 90 days, so a
 *  candidate not refreshed in 90 days is no longer a current match. */
export const DISCOVERY_STALE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  /** Stale 'new' discovery candidates deleted. */
  discoveryStaleDeleted: number;
  /** Soft-removed bundle prospects hard-deleted. */
  bundleProspectsDeleted: number;
  errors: string[];
}

export interface RetentionOptions {
  service: SupabaseClient;
  /** Injectable clock for tests. */
  now?: () => number;
  discoveryStaleDays?: number;
}

export async function purgeScrapedData(opts: RetentionOptions): Promise<RetentionResult> {
  const { service, now = Date.now, discoveryStaleDays = DISCOVERY_STALE_DAYS } = opts;
  const result: RetentionResult = {
    discoveryStaleDeleted: 0,
    bundleProspectsDeleted: 0,
    errors: [],
  };

  // 1. Stale discovery candidates — never actioned, no longer matched.
  try {
    const cutoff = new Date(now() - discoveryStaleDays * DAY_MS).toISOString();
    const { count, error } = await service
      .from("discovery_candidates")
      .delete({ count: "exact" })
      .eq("status", "new")
      .lt("last_seen_at", cutoff);
    if (error) throw new Error(error.message);
    result.discoveryStaleDeleted = count ?? 0;
  } catch (err) {
    result.errors.push(`discovery stale purge: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Soft-removed bundle prospects every subscriber has synced past.
  try {
    result.bundleProspectsDeleted = await purgeRemovedBundleProspects(service);
  } catch (err) {
    result.errors.push(`bundle prospect purge: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Hard-delete soft-removed prospects that no active subscription still needs.
 * Per bundle, the safe threshold is the MINIMUM synced_version across its active
 * subscriptions: a subscriber applies a removal only when
 * removed_in_version <= its pinned (committed) version, so a row is safe to drop
 * once removed_in_version <= every active subscriber's synced_version. A bundle
 * with no active subscriptions can drop all its soft-removed rows.
 */
async function purgeRemovedBundleProspects(service: SupabaseClient): Promise<number> {
  // Both reads paginate (CONVENTIONS §d): PostgREST truncates at 1000 rows and
  // says nothing, and each read was silently wrong past that in a different
  // direction (CAR-207). Truncating the BUNDLE list stops purging bundles past
  // the first 1000. Truncating the SUBSCRIPTION list is worse, and is data
  // loss: `minSynced` is the floor across active subscribers, so dropping the
  // subscriber that holds the floor RAISES the threshold and hard-deletes
  // soft-removed rows that subscriber still needs for its removal delta. Lose
  // every subscription row for a bundle and it reads as unsubscribed, which
  // drops all of them.
  const bundleIds = (
    await paginateAll<{ id: number }>(async (from, to) => {
      const { data, error } = await service
        .from("data_bundles")
        .select("id")
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`bundles read: ${error.message}`);
      return data as { id: number }[] | null;
    })
  ).map((b) => b.id);
  if (bundleIds.length === 0) return 0;

  const subs = await paginateAll<{ bundle_id: number; synced_version: number }>(async (from, to) => {
    const { data, error } = await service
      .from("bundle_subscriptions")
      .select("bundle_id, synced_version")
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`subscriptions read: ${error.message}`);
    return data as { bundle_id: number; synced_version: number }[] | null;
  });

  const minSynced = new Map<number, number>();
  for (const s of subs) {
    const prev = minSynced.get(s.bundle_id);
    if (prev === undefined || s.synced_version < prev) minSynced.set(s.bundle_id, s.synced_version);
  }

  let deleted = 0;
  for (const bundleId of bundleIds) {
    const threshold = minSynced.get(bundleId);
    // A subscriber that has never synced (synced_version 0) pins everything;
    // versions start at 1, so nothing is deletable for that bundle yet.
    if (threshold !== undefined && threshold <= 0) continue;

    let query = service
      .from("bundle_prospects")
      .delete({ count: "exact" })
      .eq("bundle_id", bundleId)
      .not("removed_in_version", "is", null);
    // With no active subscriber there is no version to stay behind, so every
    // soft-removed row is safe to drop and the filter is simply omitted.
    //
    // This used to pass Number.MAX_SAFE_INTEGER as the bound instead, and that
    // path had never once worked: removed_in_version is int4, so PostgREST
    // answered `value "9007199254740991" is out of range for type integer` and
    // the throw aborted the WHOLE loop. One unsubscribed bundle anywhere in the
    // catalog therefore stopped retention for every bundle after it — found by
    // the integration test for the pagination fix, which asserts this function
    // reports no errors (CAR-207).
    if (threshold !== undefined) query = query.lte("removed_in_version", threshold);

    const { count, error } = await query;
    if (error) throw new Error(`bundle ${bundleId} delete: ${error.message}`);
    deleted += count ?? 0;
  }
  return deleted;
}

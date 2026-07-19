import type { SupabaseClient } from "@supabase/supabase-js";
import { listUserPhotoObjects, deletePhotoObjectsBatch } from "@/lib/r2";
import { photoPublicBaseUrl, userPhotoKeyFromAnyUrl } from "@/lib/photo-urls";

/**
 * Storage orphan reconciliation (CAR-69).
 *
 * Cascade deletes (user deletion, contact/meeting deletion) remove DB rows but
 * never touch Supabase Storage, so objects orphan. This sweep lists each
 * tracked bucket, diffs against the table that owns it, and removes objects
 * with no matching row. It is the safety net; explicit delete paths also
 * remove storage inline for immediacy.
 *
 * Safety properties:
 * - Objects younger than `minAgeMs` (default 24h) are never deleted. This is
 *   the PRIMARY protection against the upload-before-insert race:
 *   uploadAttachment writes storage first and inserts the row after, so a
 *   just-uploaded object can transiently have no matching row. An object whose
 *   age is unknown (null/unparseable timestamp) is treated as too-recent and
 *   also skipped — the guard fails safe. Do NOT lower minAgeMs toward 0.
 * - Listing storage BEFORE the DB snapshot narrows the race window further,
 *   but is not sufficient on its own (a slow insert can land after the
 *   snapshot); the min-age guard is what makes it safe.
 * - The DB live-path set must be COMPLETE — any live path missed is a live
 *   object deleted — so the paginated reads use a stable `.order("id")` and a
 *   DB read error aborts the whole bucket rather than sweeping a partial set.
 * - Exact-path matching only: object names embed raw user filenames, so
 *   prefix parsing is never safe.
 */

const LIST_PAGE_SIZE = 100;
const DB_PAGE_SIZE = 1000;
const REMOVE_BATCH_SIZE = 100;
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const SWEPT_BUCKETS = ["attachments", "application-files"] as const;
export type SweptBucket = (typeof SWEPT_BUCKETS)[number];

// Buckets whose entire {userId}/ folder is cleared when an account is deleted.
// Superset of SWEPT_BUCKETS: `contact-photos` holds legacy pre-R2 photos that
// the daily orphan sweep can't cover (it has no live-path fetcher and RLS-owning
// table), so account deletion must clear it here (CAR-135 / R4.4). Current-backend
// contact photos live on R2 and are removed by deleteUserPhotoObjects in lib/r2.
const USER_DELETE_BUCKETS = ["attachments", "application-files", "contact-photos"] as const;

export interface BucketSweepResult {
  scanned: number;
  live: number;
  skippedRecent: number;
  removed: string[];
  errors: string[];
}

export type SweepResult = Record<SweptBucket, BucketSweepResult>;

interface StorageObject {
  path: string;
  createdAt: string | null;
}

/** Recursively list every object under a prefix (keys are `{userId}/{name}`). */
async function listAllObjects(
  service: SupabaseClient,
  bucket: string,
  rootPrefix = "",
): Promise<StorageObject[]> {
  const objects: StorageObject[] = [];
  const prefixes = [rootPrefix];
  while (prefixes.length > 0) {
    const prefix = prefixes.shift()!;
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const { data, error } = await service.storage
        .from(bucket)
        .list(prefix, { limit: LIST_PAGE_SIZE, offset });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      for (const item of data ?? []) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        // Folders come back as entries with a null id.
        if (item.id === null) prefixes.push(path);
        else objects.push({ path, createdAt: item.created_at ?? null });
      }
      if (!data || data.length < LIST_PAGE_SIZE) break;
    }
  }
  return objects;
}

/** All object_paths tracked in the attachments table for the given bucket. */
async function fetchAttachmentPaths(
  service: SupabaseClient,
  bucket: string,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await service
      .from("attachments")
      .select("object_path")
      .eq("bucket", bucket)
      // Stable total order so LIMIT/OFFSET pages can't skip rows across
      // requests (an incomplete live-path set would delete live objects).
      .order("id")
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(`attachments query: ${error.message}`);
    for (const row of (data as { object_path: string }[] | null) ?? []) {
      paths.add(row.object_path);
    }
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return paths;
}

/** All resume/cover-letter paths tracked by pipeline_applications. */
async function fetchApplicationFilePaths(
  service: SupabaseClient,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await service
      .from("pipeline_applications")
      .select("resume_path, cover_letter_path")
      .order("id")
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(`pipeline_applications query: ${error.message}`);
    const rows =
      (data as { resume_path: string | null; cover_letter_path: string | null }[] | null) ?? [];
    for (const row of rows) {
      if (row.resume_path) paths.add(row.resume_path);
      if (row.cover_letter_path) paths.add(row.cover_letter_path);
    }
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return paths;
}

const LIVE_PATH_FETCHERS: Record<
  SweptBucket,
  (service: SupabaseClient) => Promise<Set<string>>
> = {
  attachments: (service) => fetchAttachmentPaths(service, "attachments"),
  "application-files": fetchApplicationFilePaths,
};

export interface SweepOptions {
  service: SupabaseClient;
  /** Report orphans without deleting anything. */
  dryRun?: boolean;
  /** Objects newer than this are never deleted. */
  minAgeMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export async function sweepStorageOrphans(opts: SweepOptions): Promise<SweepResult> {
  const { service, dryRun = false, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now } = opts;
  const result = {} as SweepResult;

  for (const bucket of SWEPT_BUCKETS) {
    const bucketResult: BucketSweepResult = {
      scanned: 0,
      live: 0,
      skippedRecent: 0,
      removed: [],
      errors: [],
    };
    result[bucket] = bucketResult;

    let objects: StorageObject[];
    let livePaths: Set<string>;
    try {
      // Storage first, DB second — see safety notes at top of file.
      objects = await listAllObjects(service, bucket);
      livePaths = await LIVE_PATH_FETCHERS[bucket](service);
    } catch (err) {
      bucketResult.errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    bucketResult.scanned = objects.length;
    const cutoff = now() - minAgeMs;
    const orphans: string[] = [];
    for (const obj of objects) {
      if (livePaths.has(obj.path)) {
        bucketResult.live++;
        continue;
      }
      // Fail safe: an unknown or unparseable age (NaN) is treated as too-recent
      // to delete, never as old enough — the guard must never fail open on a
      // destructive path.
      const ageTs = obj.createdAt ? new Date(obj.createdAt).getTime() : NaN;
      if (Number.isNaN(ageTs) || ageTs > cutoff) {
        bucketResult.skippedRecent++;
      } else {
        orphans.push(obj.path);
      }
    }

    for (let i = 0; i < orphans.length; i += REMOVE_BATCH_SIZE) {
      const batch = orphans.slice(i, i + REMOVE_BATCH_SIZE);
      if (!dryRun) {
        const { error } = await service.storage.from(bucket).remove(batch);
        if (error) {
          bucketResult.errors.push(`remove batch: ${error.message}`);
          continue;
        }
      }
      for (const path of batch) {
        console.log(`[storage-sweep] ${dryRun ? "orphan (dry-run)" : "removed"} ${bucket}/${path}`);
      }
      bucketResult.removed.push(...batch);
    }
  }

  return result;
}

/** Max keys per S3 DeleteObjects request (mirrored in lib/r2). */
const R2_REMOVE_BATCH_SIZE = 1000;

/**
 * All live contact-photo R2 keys: every contacts.photo_url whose path is a
 * user-photo key. Completeness contract is the same as the Supabase fetchers
 * above — stable order, any read error throws and aborts the pass (a missed
 * live key is a live photo deleted) — plus two hazards specific to this
 * fetcher, both fail-open unless guarded (deep-review finding on CAR-156):
 * - The env assertion: key extraction used to go through r2KeyFromPublicUrl,
 *   which swallows an unset R2_PUBLIC_BASE_URL and returns null — an absent
 *   env var would have silently produced an EMPTY live set while the S3-side
 *   listing (different env vars) still succeeded, classifying every photo as
 *   an orphan. photoPublicBaseUrl() is asserted here eagerly so a missing
 *   base URL throws and aborts the pass instead.
 * - Host-agnostic matching: keys are extracted with userPhotoKeyFromAnyUrl,
 *   which ignores the URL's host, so photo_url rows written under an old
 *   public domain (full or partial domain migration) still count as live.
 *   Exact-current-base matching would drop them and delete live objects.
 * Deleted users need no separate existence check: their contacts rows
 * cascade away, so their keys simply never enter the live set.
 */
async function fetchLiveContactPhotoKeys(service: SupabaseClient): Promise<Set<string>> {
  // Config sanity gate — see the env-assertion note above. Throws when unset.
  photoPublicBaseUrl();
  const keys = new Set<string>();
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await service
      .from("contacts")
      .select("photo_url")
      .not("photo_url", "is", null)
      .order("id")
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(`contacts query: ${error.message}`);
    for (const row of (data as { photo_url: string | null }[] | null) ?? []) {
      const key = userPhotoKeyFromAnyUrl(row.photo_url);
      if (key) keys.add(key);
    }
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return keys;
}

/**
 * R2 pass of the daily sweep (CAR-156): contact photos on the public CDN whose
 * key no contacts.photo_url references are orphans (photo replaced, contact
 * deleted, or account deleted with the best-effort inline cleanup missed).
 * Reuses the Supabase sweep's safety properties: R2 listed BEFORE the DB
 * snapshot, complete-live-set-or-abort, exact-key matching only (host-agnostic
 * — see fetchLiveContactPhotoKeys), and the min-age guard (an object is
 * written before contacts.photo_url starts pointing at it, so a young
 * unreferenced key may be a pointer swap still in flight — and an unknown age
 * fails safe as too-recent). Two additional guards close the fail-open modes
 * a deep review found here: the eager R2_PUBLIC_BASE_URL assertion and the
 * zero-live-set tripwire below.
 */
export async function sweepR2PhotoOrphans(opts: SweepOptions): Promise<BucketSweepResult> {
  const { service, dryRun = false, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now } = opts;
  const result: BucketSweepResult = {
    scanned: 0,
    live: 0,
    skippedRecent: 0,
    removed: [],
    errors: [],
  };

  let objects: Awaited<ReturnType<typeof listUserPhotoObjects>>;
  let liveKeys: Set<string>;
  try {
    objects = await listUserPhotoObjects();
    liveKeys = await fetchLiveContactPhotoKeys(service);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  result.scanned = objects.length;

  // Tripwire: objects exist but not a single live key resolved. In any real
  // deployment that is a misconfiguration or parsing regression (an
  // all-orphans bucket would require every photo-holding contact to be gone),
  // and the failure mode of proceeding is deleting every user's photos.
  // Refuse to sweep; leaving orphans is benign and self-heals next run.
  if (objects.length > 0 && liveKeys.size === 0) {
    result.errors.push(
      `live set resolved to 0 keys while ${objects.length} objects exist — refusing to sweep (likely misconfiguration)`,
    );
    return result;
  }
  const cutoff = now() - minAgeMs;
  const orphans: string[] = [];
  for (const obj of objects) {
    if (liveKeys.has(obj.key)) {
      result.live++;
      continue;
    }
    const ageTs = obj.lastModified ? obj.lastModified.getTime() : NaN;
    if (Number.isNaN(ageTs) || ageTs > cutoff) {
      result.skippedRecent++;
    } else {
      orphans.push(obj.key);
    }
  }

  for (let i = 0; i < orphans.length; i += R2_REMOVE_BATCH_SIZE) {
    const batch = orphans.slice(i, i + R2_REMOVE_BATCH_SIZE);
    if (!dryRun) {
      try {
        await deletePhotoObjectsBatch(batch);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }
    }
    for (const key of batch) {
      console.log(`[storage-sweep] ${dryRun ? "orphan (dry-run)" : "removed"} r2/${key}`);
    }
    result.removed.push(...batch);
  }

  return result;
}

/**
 * Best-effort inline cleanup of one user's Supabase Storage before their account
 * is deleted (auth.admin.deleteUser cascades the DB rows but not storage). Clears
 * the user's folder in every USER_DELETE_BUCKETS bucket, including the legacy
 * contact-photos bucket. R2 contact photos are handled separately by
 * deleteUserPhotoObjects (lib/r2). Errors are swallowed — for the swept buckets
 * the daily sweep self-heals anything missed here.
 */
export async function removeUserStorageObjects(
  service: SupabaseClient,
  userId: string,
): Promise<void> {
  // Guard against a falsy userId — an empty prefix would list and delete every
  // object in the bucket for all users. This function is an unconditional,
  // un-aged, cross-user delete primitive; never let it run bucket-wide.
  if (!userId) throw new Error("removeUserStorageObjects: userId is required");
  for (const bucket of USER_DELETE_BUCKETS) {
    try {
      const userPaths = (await listAllObjects(service, bucket, userId)).map((o) => o.path);
      for (let i = 0; i < userPaths.length; i += REMOVE_BATCH_SIZE) {
        const batch = userPaths.slice(i, i + REMOVE_BATCH_SIZE);
        const { error } = await service.storage.from(bucket).remove(batch);
        if (error) throw new Error(error.message);
        for (const path of batch) {
          console.log(`[user-delete] removed ${bucket}/${path}`);
        }
      }
    } catch (err) {
      console.error(`[user-delete] storage cleanup failed for ${bucket}:`, err);
    }
  }
}

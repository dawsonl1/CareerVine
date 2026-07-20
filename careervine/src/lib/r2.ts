/**
 * Cloudflare R2 object storage for contact photos (CAR-35).
 *
 * Server-only — credentials come from env, so every browser-initiated write
 * goes through an API route. Objects are immutable: keys embed a content
 * hash, uploads set a forever cache header, and replacing a photo means
 * writing a new key and deleting the old one. Serving happens on the public
 * custom domain (R2_PUBLIC_BASE_URL → assets.careervine.app) with free
 * egress through the Cloudflare CDN.
 *
 * URL predicates and the key layout live in lib/photo-urls.ts (no SDK
 * dependency, importable anywhere); this module owns the S3 I/O.
 */

import "server-only";

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import {
  USER_PHOTO_PREFIX,
  BUNDLE_PHOTO_PREFIX,
  r2PublicUrl,
  r2KeyFromPublicUrl,
  isBundlePhotoUrl,
  isUserPhotoUrl,
} from "@/lib/photo-urls";

export { r2PublicUrl, r2KeyFromPublicUrl, isBundlePhotoUrl, isUserPhotoUrl };

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

let client: S3Client | null = null;

function getR2Client(): S3Client {
  if (!client) {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Keys ───────────────────────────────────────────────────────────────

export function userPhotoKey(userId: string, contactId: number, bytes: Uint8Array): string {
  return `${USER_PHOTO_PREFIX}${userId}/${contactId}-${sha256Hex(bytes).slice(0, 8)}.webp`;
}

export function bundlePhotoKey(bytes: Uint8Array): string {
  return `${BUNDLE_PHOTO_PREFIX}${sha256Hex(bytes).slice(0, 16)}.webp`;
}

// ── Object I/O ─────────────────────────────────────────────────────────

export async function putPhotoObject(key: string, bytes: Uint8Array): Promise<void> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
      Body: bytes,
      ContentType: "image/webp",
      CacheControl: IMMUTABLE_CACHE,
    }),
  );
}

export async function deletePhotoObject(key: string): Promise<void> {
  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
    }),
  );
}

/** Best-effort delete of the object behind a photo_url we own; never throws. */
export async function deletePhotoByUrl(url: string | null | undefined): Promise<void> {
  const key = r2KeyFromPublicUrl(url);
  if (!key) return;
  try {
    await deletePhotoObject(key);
  } catch (err) {
    console.warn(`[r2] Photo cleanup failed for ${key}:`, err);
  }
}

/** Max keys per S3 DeleteObjects request. */
const DELETE_BATCH_SIZE = 1000;

export interface R2PhotoObject {
  key: string;
  /** S3 LastModified; null when the listing omits it (treated as too-recent by the sweep). */
  lastModified: Date | null;
}

/**
 * List every contact-photo object across all users (the whole
 * `careervine/contact-photos/` prefix) with its age, for the daily orphan
 * sweep (CAR-156). Throws on any listing error — the sweep must abort rather
 * than reason from a partial view. Bundle photos live under a different
 * prefix and are never listed.
 */
export async function listUserPhotoObjects(): Promise<R2PhotoObject[]> {
  const bucket = requireEnv("R2_BUCKET");
  const s3 = getR2Client();
  const objects: R2PhotoObject[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: USER_PHOTO_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      objects.push({ key: obj.Key, lastModified: obj.LastModified ?? null });
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * Delete one batch of keys (max 1000 — the S3 DeleteObjects limit). Throws on
 * failure, including per-key errors reported inside a 200 response; the sweep
 * records the error and moves on to the next batch.
 */
export async function deletePhotoObjectsBatch(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (keys.length > DELETE_BATCH_SIZE) {
    throw new Error(`deletePhotoObjectsBatch: ${keys.length} keys exceeds the ${DELETE_BATCH_SIZE}-key limit`);
  }
  const result = await getR2Client().send(
    new DeleteObjectsCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
  const failed = result.Errors ?? [];
  if (failed.length > 0) {
    throw new Error(
      `deletePhotoObjectsBatch: ${failed.length} keys failed (first: ${failed[0].Key}: ${failed[0].Message})`,
    );
  }
}

/**
 * Best-effort removal of every per-user contact photo under a deleted account's
 * R2 prefix (`careervine/contact-photos/{userId}/`). DB rows cascade on account
 * deletion but R2 objects on the public CDN do not, so without this they orphan
 * forever (CAR-135 / R4.4). Shared bundle photos live under a different prefix
 * and are never touched. Never throws — the caller is a delete path.
 */
export async function deleteUserPhotoObjects(userId: string): Promise<void> {
  // An empty userId collapses the prefix to the shared contact-photos root and
  // would enumerate and delete every user's photos. Never allow it.
  if (!userId) throw new Error("deleteUserPhotoObjects: userId is required");
  const prefix = `${USER_PHOTO_PREFIX}${userId}/`;
  try {
    const bucket = requireEnv("R2_BUCKET");
    const s3 = getR2Client();
    let continuationToken: string | undefined;
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));
      for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        );
        for (const key of batch) console.log(`[user-delete] removed R2 ${key}`);
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    console.error(`[r2] User photo cleanup failed for ${userId}:`, err);
  }
}

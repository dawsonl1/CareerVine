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

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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

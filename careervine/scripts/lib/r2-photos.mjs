/**
 * R2 photo helpers for the ops scripts (CAR-35). Mirrors the key scheme and
 * thumbnail settings in src/lib/photo-urls.ts / photo-thumb.ts — keep the
 * constants aligned if either changes.
 *
 * Env (same names the app uses; source careervine/.env.local):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET, R2_PUBLIC_BASE_URL
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import sharp from "sharp";

export const USER_PHOTO_PREFIX = "careervine/contact-photos/";
export const BUNDLE_PHOTO_PREFIX = "careervine/bundle-photos/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const THUMB_PX = 256;
const THUMB_QUALITY = 75;

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set — source careervine/.env.local first`);
    process.exit(1);
  }
  return value;
}

export function publicBaseUrl() {
  return requireEnv("R2_PUBLIC_BASE_URL").replace(/\/+$/, "");
}

let client = null;
export function r2Client() {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function makeThumb(bytes) {
  return sharp(Buffer.from(bytes))
    .rotate()
    .resize(THUMB_PX, THUMB_PX, { fit: "cover" })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

export async function putPhoto(key, bytes) {
  await r2Client().send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
      Body: bytes,
      ContentType: "image/webp",
      CacheControl: IMMUTABLE_CACHE,
    }),
  );
  return `${publicBaseUrl()}/${key}`;
}

export async function deletePhoto(key) {
  await r2Client().send(
    new DeleteObjectCommand({ Bucket: requireEnv("R2_BUCKET"), Key: key }),
  );
}

export function bundlePhotoKey(thumbBytes) {
  return `${BUNDLE_PHOTO_PREFIX}${sha256Hex(thumbBytes).slice(0, 16)}.webp`;
}

export function userPhotoKey(userId, contactId, thumbBytes) {
  return `${USER_PHOTO_PREFIX}${userId}/${contactId}-${sha256Hex(thumbBytes).slice(0, 8)}.webp`;
}

/** Fetch → thumb → put under the shared bundle prefix. Returns the public URL. */
export async function mirrorToBundlePhoto(sourceUrl, { timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let bytes;
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, redirect: "error" });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    bytes = await res.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(`too large (${bytes.byteLength} bytes)`);
  const thumb = await makeThumb(bytes);
  return putPhoto(bundlePhotoKey(thumb), thumb);
}

/** Run fn over items with bounded concurrency; preserves order of results. */
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Contact-photo URL scheme (CAR-35) — pure predicates/builders with no SDK
 * dependencies, safe to import from any module (the S3 client itself lives
 * in lib/r2.ts, server-only).
 *
 * Key layout inside the shared dawsonsprojects-assets bucket:
 *   careervine/contact-photos/{userId}/{contactId}-{hash8}.webp  (per-user)
 *   careervine/bundle-photos/{hash16}.webp                       (shared across all subscribers)
 */

export const USER_PHOTO_PREFIX = "careervine/contact-photos/";
export const BUNDLE_PHOTO_PREFIX = "careervine/bundle-photos/";

/** Public base URL (no trailing slash). Throws when unconfigured. */
export function photoPublicBaseUrl(): string {
  const value = process.env.R2_PUBLIC_BASE_URL;
  if (!value) throw new Error("R2_PUBLIC_BASE_URL is not configured");
  return value.replace(/\/+$/, "");
}

export function r2PublicUrl(key: string): string {
  return `${photoPublicBaseUrl()}/${key}`;
}

/** The R2 key embedded in one of our public photo URLs, or null. */
export function r2KeyFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let prefix: string;
  try {
    prefix = `${photoPublicBaseUrl()}/`;
  } catch {
    return null;
  }
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return key.startsWith(USER_PHOTO_PREFIX) || key.startsWith(BUNDLE_PHOTO_PREFIX) ? key : null;
}

/** True for photos in the shared bundle prefix — the only photo_url values
 * bundle sync is allowed to write (and overwrite) on subscribers' contacts. */
export function isBundlePhotoUrl(url: string | null | undefined): boolean {
  const key = r2KeyFromPublicUrl(url);
  return key != null && key.startsWith(BUNDLE_PHOTO_PREFIX);
}

/** True for per-user photos we own (upload/import mirrors). */
export function isUserPhotoUrl(url: string | null | undefined): boolean {
  const key = r2KeyFromPublicUrl(url);
  return key != null && key.startsWith(USER_PHOTO_PREFIX);
}

/**
 * Bundle-sync photo policy: a shared bundle photo may land on a contact
 * only when it changes something and never over a photo the user put there
 * themselves (manual upload / direct import mirror) — those aren't bundle
 * URLs. Safe fingerprint-wise: photo_url is importer-owned surface.
 */
export function bundlePhotoOverwriteAllowed(
  existingUrl: string | null,
  incomingUrl: string | null | undefined,
): boolean {
  return (
    isBundlePhotoUrl(incomingUrl) &&
    incomingUrl !== existingUrl &&
    (existingUrl == null || isBundlePhotoUrl(existingUrl))
  );
}

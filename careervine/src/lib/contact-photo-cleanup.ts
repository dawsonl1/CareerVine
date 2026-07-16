/**
 * Single-contact photo cleanup (CAR-135 / R4.4).
 *
 * A contact's photo lives outside Postgres — either as a per-user object on R2
 * (the current backend) or, for pre-migration rows, in the legacy Supabase
 * `contact-photos` bucket. Neither cascades when the contact row is deleted, so
 * every delete/replace path must clear the object explicitly or it orphans on
 * the public CDN forever. This is the one shared implementation used by the
 * photo route (replace/remove) and every contact-deletion path.
 *
 * Shared bundle photos (used across all subscribers) are deliberately left
 * untouched: they are not owned by any single contact.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUserPhotoUrl, deletePhotoByUrl } from "@/lib/r2";

/** Marker in a legacy photo_url that points at the Supabase contact-photos bucket. */
export const LEGACY_SUPABASE_PHOTO_MARKER = "/storage/v1/object/public/contact-photos/";

/**
 * Best-effort removal of a single contact's own photo object, R2 or legacy
 * Supabase. Null urls and shared bundle photos are ignored. Never throws — every
 * caller is a delete/replace path where storage cleanup must not block the DB
 * write.
 */
export async function cleanupContactPhoto(
  supabase: SupabaseClient,
  userId: string,
  contactId: number,
  photoUrl: string | null | undefined,
): Promise<void> {
  if (!photoUrl) return;
  if (isUserPhotoUrl(photoUrl)) {
    await deletePhotoByUrl(photoUrl);
  } else if (photoUrl.includes(LEGACY_SUPABASE_PHOTO_MARKER)) {
    try {
      await supabase.storage.from("contact-photos").remove([`${userId}/${contactId}.jpg`]);
    } catch (err) {
      console.warn(`[contact-photo] Legacy cleanup failed for contact ${contactId}:`, err);
    }
  }
}

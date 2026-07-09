/**
 * Suppression tombstone policy.
 *
 * suppressed_imports rows are deletion tombstones: bulk import skips any
 * people-record whose canonical linkedin_url is suppressed, so deleted
 * contacts don't resurrect on the next tranche re-run.
 */

import { canonicalizeLinkedinUrl } from "./linkedin-url";

/**
 * Decide whether deleting a contact should write a suppressed_imports
 * tombstone, and for which canonical URL. Returns null when no tombstone
 * should be written.
 *
 * Only scrape-imported contacts qualify (import_source "apify:…" — written
 * by every pipeline import merge, never by the extension/manual paths).
 * Extension and manual contacts are not re-created by bulk import, and
 * suppressing their URL would silently block future pipeline refreshes of
 * that person.
 */
export function suppressionTombstoneUrl(contact: {
  linkedin_url: string | null;
  import_source: string | null;
}): string | null {
  if (!contact.import_source?.startsWith("apify:")) return null;
  return canonicalizeLinkedinUrl(contact.linkedin_url);
}

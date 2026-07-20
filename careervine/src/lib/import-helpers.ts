/**
 * Shared helpers for the contact import flow.
 * Extracted for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findOrCreateLocation as findOrCreateLocationCanonical } from '@/lib/data/locations';
import type { QueryClient } from '@/lib/data/client';
import type { Database } from '@/lib/database.types';
import type { ProfileData } from '@/lib/extension-contract';

// The builders write the contacts table, so their payloads are exactly the
// generated insert/update column maps (CAR-158). Typing them this way also
// makes the route's later `updateData.location_id = ...` a checked write.
type ContactInsert = Database['public']['Tables']['contacts']['Insert'];
type ContactUpdate = Database['public']['Tables']['contacts']['Update'];

/**
 * Single source of contact-email validity for the import route. Both the
 * create and the update path gate the primary-email insert through this so
 * they can't drift (CAR-148 F11): basic RFC-ish shape + Postgres varchar-safe
 * length cap.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidContactEmail(email: string | null | undefined): email is string {
  return typeof email === 'string' && EMAIL_REGEX.test(email) && email.length <= 320;
}

/**
 * Resolve the tag list from a profile payload: prefer `suggested_tags`, fall back
 * to a legacy `tags` array. `suggested_tags` is schema-defaulted to `[]` on the
 * import wire (CAR-148), so a bare `suggested_tags || tags` would let the empty
 * default (truthy) mask the fallback and silently drop a legacy `tags`-only
 * payload's tags. Checking for a non-empty array preserves the fallback. Shared
 * by both import paths so they can't drift.
 */
export function resolveImportTags(profileData: Partial<ProfileData>): string[] | undefined {
  return profileData.suggested_tags?.length ? profileData.suggested_tags : profileData.tags;
}

/** Convert follow-up frequency string to days */
export function parseFollowUpFrequency(freq: string | null | undefined): number | null {
  if (!freq) return null;
  const map: Record<string, number> = {
    '2 weeks': 14,
    '2 months': 60,
    '3 months': 90,
    '6 months': 180,
    '1 year': 365,
  };
  return map[freq] ?? null;
}

/** Sanitize a string for use in PostgREST .or()/.ilike() filters */
export function sanitizeForPostgrest(s: string): string {
  return s.replace(/[%_\\.,()'"]/g, '');
}

/**
 * Strip only the STRUCTURAL metacharacters of a PostgREST `.or()` / array
 * literal (`,`, `(`, `)`, `{`, `}`) from a value interpolated into one. Unlike
 * sanitizeForPostgrest it preserves `.`, `@`, `-`, `+`, so it is SAFE for exact
 * eq/email values (sanitizeForPostgrest would strip the domain dots and break
 * the match). Defense-in-depth behind schema validation (CAR-149, F48) — a
 * value already validated as an email has none of these, so it passes through
 * unchanged, but a schema regression can't reopen the injection surface.
 */
export function stripPostgrestOrMetachars(s: string): string {
  return s.replace(/[,(){}]/g, '');
}

// The builders defensively read only a handful of scalar profile fields (never
// location/experience/education/suggested_tags — those are handled by the route
// itself), so they accept a Partial: the route passes a full parsed ProfileData,
// tests pass focused fixtures, and both are valid input.
/** Build the contact data object for insert from extension profile data */
export function buildContactData(profileData: Partial<ProfileData>, userId: string, locationId: number | null): ContactInsert {
  let notes = profileData.generated_notes || profileData.notes || null;
  if (!notes) {
    notes = `Imported from LinkedIn on ${new Date().toLocaleDateString()}`;
  }

  return {
    user_id: userId,
    name: profileData.name || 'Unknown',
    linkedin_url: profileData.linkedin_url || profileData.profileUrl || null,
    industry: profileData.industry || null,
    location_id: locationId,
    notes,
    contact_status: profileData.contact_status || 'professional',
    expected_graduation: profileData.expected_graduation || null,
    status_derived_at: new Date().toISOString(),
    follow_up_frequency_days: parseFollowUpFrequency(profileData.follow_up_frequency) ?? (profileData.follow_up_frequency_days || null),
  };
}

/** Build the update data object for an existing contact */
export function buildUpdateData(profileData: Partial<ProfileData>): ContactUpdate {
  const updateData: ContactUpdate = {};

  if (profileData.name) updateData.name = profileData.name;
  if (profileData.industry) updateData.industry = profileData.industry;
  const linkedinUrl = profileData.linkedin_url || profileData.profileUrl;
  if (linkedinUrl) updateData.linkedin_url = linkedinUrl;
  if (profileData.contact_status) {
    updateData.contact_status = profileData.contact_status;
    updateData.status_derived_at = new Date().toISOString();
  }
  if (profileData.expected_graduation) updateData.expected_graduation = profileData.expected_graduation;

  const notes = profileData.generated_notes || profileData.notes;
  if (notes) updateData.notes = notes;

  const freqDays = parseFollowUpFrequency(profileData.follow_up_frequency);
  if (freqDays !== null) updateData.follow_up_frequency_days = freqDays;

  return updateData;
}

/**
 * Resolve a contact-level profile location ({city, state, country}) to a
 * locations row. Normalization ('CA' vs 'California', metro aliases) runs
 * inside the canonical findOrCreateLocation itself (CAR-155, completing
 * CAR-139 / F27 structurally), so this is a thin resolve.
 */
export async function resolveProfileLocationId(
  supabase: SupabaseClient,
  profileLocation: { city?: string | null; state?: string | null; country?: string | null },
): Promise<number | null> {
  const location = await findOrCreateLocationCanonical(profileLocation, {
    client: supabase as unknown as QueryClient,
  });
  return location?.id ?? null;
}

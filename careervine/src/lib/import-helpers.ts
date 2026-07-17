/**
 * Shared helpers for the contact import flow.
 * Extracted for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findOrCreateLocation } from '@/lib/company-helpers';
import { normalizeParsedLocation } from '@/lib/location-normalizer';
import type { ProfileData } from '@/lib/extension-contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase insert/update payloads are untyped column maps until the typed-Supabase-boundary rollout (CAR-142).
type ColumnMap = Record<string, any>;

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

// The builders defensively read only a handful of scalar profile fields (never
// location/experience/education/suggested_tags — those are handled by the route
// itself), so they accept a Partial: the route passes a full parsed ProfileData,
// tests pass focused fixtures, and both are valid input.
/** Build the contact data object for insert from extension profile data */
export function buildContactData(profileData: Partial<ProfileData>, userId: string, locationId: number | null): ColumnMap {
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
export function buildUpdateData(profileData: Partial<ProfileData>): ColumnMap {
  const updateData: ColumnMap = {};

  if (profileData.name) updateData.name = profileData.name;
  if (profileData.industry) updateData.industry = profileData.industry;
  if (profileData.linkedin_url || profileData.profileUrl) {
    updateData.linkedin_url = profileData.linkedin_url || profileData.profileUrl;
  }
  if (profileData.contact_status) {
    updateData.contact_status = profileData.contact_status;
    updateData.status_derived_at = new Date().toISOString();
  }
  if (profileData.expected_graduation) updateData.expected_graduation = profileData.expected_graduation;

  if (profileData.generated_notes || profileData.notes) {
    updateData.notes = profileData.generated_notes || profileData.notes;
  }

  const freqDays = parseFollowUpFrequency(profileData.follow_up_frequency);
  if (freqDays !== null) updateData.follow_up_frequency_days = freqDays;

  return updateData;
}

/**
 * Resolve a contact-level profile location ({city, state, country}) to a
 * locations row. Normalizes first (CAR-139 / F27) so raw variants ('CA' vs
 * 'California', metro aliases) collapse onto one canonical row, matching the
 * experience-row import path.
 */
export async function resolveProfileLocationId(
  supabase: SupabaseClient,
  profileLocation: { city?: string | null; state?: string | null; country?: string | null },
): Promise<number | null> {
  const norm = normalizeParsedLocation(profileLocation);
  if (!norm.city && !norm.state && !norm.country) return null;
  const location = await findOrCreateLocation(supabase, {
    city: norm.city,
    state: norm.state,
    country: norm.country || 'United States',
  });
  return location.id;
}

/**
 * Shared helpers for the contact import flow.
 * Extracted for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findOrCreateLocation } from '@/lib/company-helpers';
import { normalizeParsedLocation } from '@/lib/location-normalizer';

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

/** Build the contact data object for insert from extension profile data */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
export function buildContactData(profileData: any, userId: string, locationId: number | null): Record<string, any> {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
export function buildUpdateData(profileData: any): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  const updateData: Record<string, any> = {};

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

/**
 * Shared helpers for the contact import flow.
 * Extracted for testability.
 */

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
  return s.replace(/[%_\\.,()]/g, '');
}

/** Build the contact data object for insert from extension profile data */
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
    follow_up_frequency_days: parseFollowUpFrequency(profileData.follow_up_frequency) ?? (profileData.follow_up_frequency_days || null),
  };
}

/** Build the update data object for an existing contact */
export function buildUpdateData(profileData: any): Record<string, any> {
  const updateData: Record<string, any> = {};

  if (profileData.name) updateData.name = profileData.name;
  if (profileData.industry) updateData.industry = profileData.industry;
  if (profileData.linkedin_url || profileData.profileUrl) {
    updateData.linkedin_url = profileData.linkedin_url || profileData.profileUrl;
  }
  if (profileData.contact_status) updateData.contact_status = profileData.contact_status;
  if (profileData.expected_graduation) updateData.expected_graduation = profileData.expected_graduation;

  if (profileData.generated_notes || profileData.notes) {
    updateData.notes = profileData.generated_notes || profileData.notes;
  }

  const freqDays = parseFollowUpFrequency(profileData.follow_up_frequency);
  if (freqDays !== null) updateData.follow_up_frequency_days = freqDays;

  return updateData;
}

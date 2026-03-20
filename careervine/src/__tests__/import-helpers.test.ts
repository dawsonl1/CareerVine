import { describe, it, expect } from 'vitest';
import {
  parseFollowUpFrequency,
  sanitizeForPostgrest,
  buildContactData,
  buildUpdateData,
} from '@/lib/import-helpers';

describe('parseFollowUpFrequency', () => {
  it('converts "2 weeks" to 14', () => {
    expect(parseFollowUpFrequency('2 weeks')).toBe(14);
  });

  it('converts "2 months" to 60', () => {
    expect(parseFollowUpFrequency('2 months')).toBe(60);
  });

  it('converts "3 months" to 90', () => {
    expect(parseFollowUpFrequency('3 months')).toBe(90);
  });

  it('converts "6 months" to 180', () => {
    expect(parseFollowUpFrequency('6 months')).toBe(180);
  });

  it('converts "1 year" to 365', () => {
    expect(parseFollowUpFrequency('1 year')).toBe(365);
  });

  it('returns null for "No follow-up"', () => {
    expect(parseFollowUpFrequency('No follow-up')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFollowUpFrequency('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseFollowUpFrequency(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseFollowUpFrequency(undefined)).toBeNull();
  });

  it('returns null for unknown frequency string', () => {
    expect(parseFollowUpFrequency('every day')).toBeNull();
  });
});

describe('sanitizeForPostgrest', () => {
  it('strips percent signs', () => {
    expect(sanitizeForPostgrest('100%')).toBe('100');
  });

  it('strips underscores', () => {
    expect(sanitizeForPostgrest('john_doe')).toBe('johndoe');
  });

  it('strips backslashes', () => {
    expect(sanitizeForPostgrest('O\\Brien')).toBe('OBrien');
  });

  it('strips apostrophes', () => {
    expect(sanitizeForPostgrest("O'Brien")).toBe('OBrien');
  });

  it('strips double quotes', () => {
    expect(sanitizeForPostgrest('"Johnny"')).toBe('Johnny');
  });

  it('strips dots', () => {
    expect(sanitizeForPostgrest('J.R.')).toBe('JR');
  });

  it('strips commas', () => {
    expect(sanitizeForPostgrest('Smith, Jr')).toBe('Smith Jr');
  });

  it('strips parentheses', () => {
    expect(sanitizeForPostgrest('John (Johnny)')).toBe('John Johnny');
  });

  it('leaves normal names unchanged', () => {
    expect(sanitizeForPostgrest('John Smith')).toBe('John Smith');
  });

  it('handles empty string', () => {
    expect(sanitizeForPostgrest('')).toBe('');
  });
});

describe('buildContactData', () => {
  it('maps extension profile fields to database columns', () => {
    const profileData = {
      name: 'John Smith',
      linkedin_url: 'https://linkedin.com/in/john-smith',
      industry: 'Technology',
      generated_notes: 'Met at conference',
      contact_status: 'professional',
      expected_graduation: null,
      follow_up_frequency: '3 months',
    };

    const result = buildContactData(profileData, 'user-123', 42);

    expect(result.user_id).toBe('user-123');
    expect(result.name).toBe('John Smith');
    expect(result.linkedin_url).toBe('https://linkedin.com/in/john-smith');
    expect(result.industry).toBe('Technology');
    expect(result.notes).toBe('Met at conference');
    expect(result.location_id).toBe(42);
    expect(result.contact_status).toBe('professional');
    expect(result.follow_up_frequency_days).toBe(90);
  });

  it('uses generated_notes over plain notes', () => {
    const profileData = {
      generated_notes: 'AI generated note',
      notes: 'Manual note',
    };

    const result = buildContactData(profileData, 'user-123', null);
    expect(result.notes).toBe('AI generated note');
  });

  it('falls back to plain notes if no generated_notes', () => {
    const profileData = {
      notes: 'Manual note',
    };

    const result = buildContactData(profileData, 'user-123', null);
    expect(result.notes).toBe('Manual note');
  });

  it('generates default import note if no notes at all', () => {
    const result = buildContactData({}, 'user-123', null);
    expect(result.notes).toContain('Imported from LinkedIn on');
  });

  it('accepts profileUrl as fallback for linkedin_url', () => {
    const profileData = {
      profileUrl: 'https://linkedin.com/in/jane-doe',
    };

    const result = buildContactData(profileData, 'user-123', null);
    expect(result.linkedin_url).toBe('https://linkedin.com/in/jane-doe');
  });

  it('defaults name to Unknown', () => {
    const result = buildContactData({}, 'user-123', null);
    expect(result.name).toBe('Unknown');
  });

  it('defaults contact_status to professional', () => {
    const result = buildContactData({}, 'user-123', null);
    expect(result.contact_status).toBe('professional');
  });

  it('handles follow_up_frequency_days as direct number', () => {
    const profileData = {
      follow_up_frequency_days: 30,
    };

    const result = buildContactData(profileData, 'user-123', null);
    expect(result.follow_up_frequency_days).toBe(30);
  });
});

describe('buildUpdateData', () => {
  it('maps all extension fields for update', () => {
    const profileData = {
      name: 'Updated Name',
      industry: 'Finance',
      linkedin_url: 'https://linkedin.com/in/updated',
      contact_status: 'student',
      expected_graduation: 'May 2026',
      generated_notes: 'Updated notes',
      follow_up_frequency: '6 months',
    };

    const result = buildUpdateData(profileData);

    expect(result.name).toBe('Updated Name');
    expect(result.industry).toBe('Finance');
    expect(result.linkedin_url).toBe('https://linkedin.com/in/updated');
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('May 2026');
    expect(result.notes).toBe('Updated notes');
    expect(result.follow_up_frequency_days).toBe(180);
  });

  it('only includes fields that are present', () => {
    const profileData = {
      name: 'Just Name',
    };

    const result = buildUpdateData(profileData);

    expect(result.name).toBe('Just Name');
    expect(result).not.toHaveProperty('industry');
    expect(result).not.toHaveProperty('linkedin_url');
    expect(result).not.toHaveProperty('notes');
    expect(result).not.toHaveProperty('follow_up_frequency_days');
  });

  it('returns empty object for empty profile data', () => {
    const result = buildUpdateData({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('prefers generated_notes over notes', () => {
    const profileData = {
      generated_notes: 'AI note',
      notes: 'Manual note',
    };

    const result = buildUpdateData(profileData);
    expect(result.notes).toBe('AI note');
  });

  it('does not include updated_at (column does not exist)', () => {
    const result = buildUpdateData({ name: 'Test' });
    expect(result).not.toHaveProperty('updated_at');
  });
});

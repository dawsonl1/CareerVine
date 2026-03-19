import { describe, it, expect } from 'vitest';
import { encodeProfileData, decodeProfileData } from '@/lib/profile-encoding';

describe('profile encoding roundtrip', () => {
  it('roundtrips simple ASCII data', () => {
    const data = { name: 'John Smith', industry: 'Tech' };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('roundtrips Unicode characters (CJK)', () => {
    const data = { name: '田中太郎', industry: 'テクノロジー' };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('roundtrips emoji characters', () => {
    const data = { notes: 'Great meeting! 🚀💼' };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('roundtrips accented Latin characters', () => {
    const data = { name: 'José García-López', location: { city: 'São Paulo' } };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('roundtrips Arabic script', () => {
    const data = { name: 'محمد علي' };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('roundtrips a full profile object', () => {
    const data = {
      first_name: 'Jane',
      last_name: 'Doe',
      name: 'Jane Doe',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      industry: 'Finance',
      generated_notes: 'Senior analyst at Goldman Sachs.',
      suggested_tags: ['finance', 'investment banking'],
      experience: [
        {
          company: 'Goldman Sachs',
          title: 'Senior Analyst',
          start_month: 'Jan 2020',
          end_month: 'Present',
          is_current: true,
        },
      ],
      education: [
        {
          school: 'Wharton School',
          degree: "Bachelor's",
          field_of_study: 'Finance',
          end_year: '2019',
        },
      ],
      contact_status: 'professional',
      linkedin_url: 'https://linkedin.com/in/jane-doe',
    };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('handles empty object', () => {
    const data = {};
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('handles special JSON characters', () => {
    const data = { notes: 'Said "hello" & \'goodbye\'\nnewline\ttab' };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });

  it('handles null values', () => {
    const data = { name: 'Test', industry: null, expected_graduation: null };
    const encoded = encodeProfileData(data);
    const decoded = decodeProfileData(encoded);
    expect(decoded).toEqual(data);
  });
});

describe('encodeProfileData', () => {
  it('returns a string (not empty)', () => {
    const result = encodeProfileData({ name: 'Test' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns URL-safe string (no raw + or /)', () => {
    // encodeURIComponent should handle any unsafe chars
    const result = encodeProfileData({ data: 'a+b/c=d' });
    expect(result).not.toMatch(/[+/](?!%)/); // no unencoded + or /
  });
});

describe('decodeProfileData', () => {
  it('throws on invalid base64', () => {
    expect(() => decodeProfileData('not-valid-base64!!!')).toThrow();
  });

  it('throws on valid base64 but invalid JSON', () => {
    const notJson = encodeURIComponent(btoa('this is not json'));
    expect(() => decodeProfileData(notJson)).toThrow();
  });
});

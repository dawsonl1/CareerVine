import { describe, it, expect } from 'vitest';
import {
  addIsCurrentToExperience,
  addIsCurrentToEducation,
  deriveCurrentRole,
  deriveContactStatus,
} from '@/lib/profile-helpers';

describe('addIsCurrentToExperience', () => {
  it('marks experience with end_month "Present" as current', () => {
    const result = addIsCurrentToExperience([
      { company: 'Acme', title: 'Engineer', end_month: 'Present' },
    ]);
    expect(result[0].is_current).toBe(true);
  });

  it('marks experience with other end_month as not current', () => {
    const result = addIsCurrentToExperience([
      { company: 'Acme', title: 'Engineer', end_month: 'Dec 2023' },
    ]);
    expect(result[0].is_current).toBe(false);
  });

  it('marks experience with null end_month as not current', () => {
    const result = addIsCurrentToExperience([
      { company: 'Acme', title: 'Engineer', end_month: null },
    ]);
    expect(result[0].is_current).toBe(false);
  });

  it('preserves all original fields', () => {
    const result = addIsCurrentToExperience([
      { company: 'Acme', title: 'Engineer', start_month: 'Jan 2020', end_month: 'Present', location: 'NYC' },
    ]);
    expect(result[0].company).toBe('Acme');
    expect(result[0].title).toBe('Engineer');
    expect(result[0].start_month).toBe('Jan 2020');
    expect(result[0].location).toBe('NYC');
  });

  it('handles empty array', () => {
    expect(addIsCurrentToExperience([])).toEqual([]);
  });

  it('handles multiple entries correctly', () => {
    const result = addIsCurrentToExperience([
      { company: 'Old Co', end_month: 'Jun 2022' },
      { company: 'Current Co', end_month: 'Present' },
    ]);
    expect(result[0].is_current).toBe(false);
    expect(result[1].is_current).toBe(true);
  });
});

describe('addIsCurrentToEducation', () => {
  it('marks education with end_year "Present" as current', () => {
    const result = addIsCurrentToEducation([
      { school: 'MIT', end_year: 'Present' },
    ]);
    expect(result[0].is_current).toBe(true);
  });

  it('marks education with a year as not current', () => {
    const result = addIsCurrentToEducation([
      { school: 'MIT', end_year: '2020' },
    ]);
    expect(result[0].is_current).toBe(false);
  });

  it('handles null end_year', () => {
    const result = addIsCurrentToEducation([
      { school: 'MIT', end_year: null },
    ]);
    expect(result[0].is_current).toBe(false);
  });
});

describe('deriveCurrentRole', () => {
  it('returns current company and title', () => {
    const result = deriveCurrentRole([
      { company: 'Old Corp', title: 'Junior Dev', is_current: false },
      { company: 'New Corp', title: 'Senior Dev', is_current: true },
    ]);
    expect(result.current_company).toBe('New Corp');
    expect(result.current_title).toBe('Senior Dev');
  });

  it('returns nulls when no current role', () => {
    const result = deriveCurrentRole([
      { company: 'Old Corp', title: 'Dev', is_current: false },
    ]);
    expect(result.current_company).toBeNull();
    expect(result.current_title).toBeNull();
  });

  it('returns nulls for empty experience', () => {
    const result = deriveCurrentRole([]);
    expect(result.current_company).toBeNull();
    expect(result.current_title).toBeNull();
  });

  it('returns first current role if multiple are current', () => {
    const result = deriveCurrentRole([
      { company: 'First', title: 'CEO', is_current: true },
      { company: 'Second', title: 'Advisor', is_current: true },
    ]);
    expect(result.current_company).toBe('First');
    expect(result.current_title).toBe('CEO');
  });
});

describe('deriveContactStatus', () => {
  it('returns student for currently enrolled education', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: true, end_year: 'Present' },
    ], 2026);
    expect(result.contact_status).toBe('student');
  });

  it('returns student for future graduation year', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: '2028' },
    ], 2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2028');
  });

  it('returns professional for past graduation', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: '2020' },
    ], 2026);
    expect(result.contact_status).toBe('professional');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns professional for empty education', () => {
    const result = deriveContactStatus([], 2026);
    expect(result.contact_status).toBe('professional');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns student with null graduation when is_current but no future year', () => {
    const result = deriveContactStatus([
      { school: 'State U', is_current: true, end_year: 'Present' },
    ], 2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns student with graduation year from future education', () => {
    const result = deriveContactStatus([
      { school: 'Undergrad', is_current: false, end_year: '2020' },
      { school: 'Grad School', is_current: false, end_year: '2027' },
    ], 2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2027');
  });

  it('handles null end_year gracefully', () => {
    const result = deriveContactStatus([
      { school: 'Unknown', is_current: false, end_year: null },
    ], 2026);
    expect(result.contact_status).toBe('professional');
  });

  it('handles non-numeric end_year', () => {
    const result = deriveContactStatus([
      { school: 'Unknown', is_current: false, end_year: 'N/A' },
    ], 2026);
    expect(result.contact_status).toBe('professional');
  });

  it('treats current year as not future (must be > currentYear)', () => {
    const result = deriveContactStatus([
      { school: 'School', is_current: false, end_year: '2026' },
    ], 2026);
    // 2026 is not > 2026, so professional
    expect(result.contact_status).toBe('professional');
  });
});

import { describe, it, expect } from 'vitest';
import {
  addIsCurrentToExperience,
  addIsCurrentToEducation,
  deriveCurrentRole,
  deriveContactStatus,
  deriveContactStatusFromDB,
  shouldRederiveStatus,
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
  // Helper to create a Date for testing
  const jan2026 = new Date(2026, 0, 15);  // Jan 15, 2026
  const jul2026 = new Date(2026, 6, 15);  // Jul 15, 2026
  const mar2027 = new Date(2027, 2, 15);  // Mar 15, 2027

  it('returns student for currently enrolled education', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: true, end_year: 'Present' },
    ], jan2026);
    expect(result.contact_status).toBe('student');
  });

  it('returns student for future graduation year (year-only)', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: '2028' },
    ], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2028');
  });

  it('returns professional for past graduation', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: '2020' },
    ], jan2026);
    expect(result.contact_status).toBe('professional');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns professional for empty education', () => {
    const result = deriveContactStatus([], jan2026);
    expect(result.contact_status).toBe('professional');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns student with null graduation when is_current but no future year', () => {
    const result = deriveContactStatus([
      { school: 'State U', is_current: true, end_year: 'Present' },
    ], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBeNull();
  });

  it('returns student with graduation year from future education', () => {
    const result = deriveContactStatus([
      { school: 'Undergrad', is_current: false, end_year: '2020' },
      { school: 'Grad School', is_current: false, end_year: '2027' },
    ], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2027');
  });

  it('handles null end_year gracefully', () => {
    const result = deriveContactStatus([
      { school: 'Unknown', is_current: false, end_year: null },
    ], jan2026);
    expect(result.contact_status).toBe('professional');
  });

  it('handles non-numeric end_year', () => {
    const result = deriveContactStatus([
      { school: 'Unknown', is_current: false, end_year: 'N/A' },
    ], jan2026);
    expect(result.contact_status).toBe('professional');
  });

  // Month-aware tests
  it('returns student when month+year end is in the future', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: 'May 2027' },
    ], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('May 2027');
  });

  it('returns professional when month+year end has passed', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: 'May 2026' },
    ], jul2026); // July 2026 is after May 2026
    expect(result.contact_status).toBe('professional');
  });

  it('returns student during graduation month (cutoff is start of next month)', () => {
    const result = deriveContactStatus([
      { school: 'MIT', is_current: false, end_year: 'Mar 2027' },
    ], mar2027); // Mar 15, 2027 — still in March, cutoff is Apr 1
    expect(result.contact_status).toBe('student');
  });

  // Year-only July rule tests
  it('year-only: student before July of graduation year', () => {
    const result = deriveContactStatus([
      { school: 'School', is_current: false, end_year: '2026' },
    ], jan2026); // Jan 2026 — before July 2026
    expect(result.contact_status).toBe('student');
  });

  it('year-only: professional after July of graduation year', () => {
    const result = deriveContactStatus([
      { school: 'School', is_current: false, end_year: '2026' },
    ], jul2026); // Jul 2026 — at/past July cutoff
    expect(result.contact_status).toBe('professional');
  });
});

describe('deriveContactStatusFromDB', () => {
  const jan2026 = new Date(2026, 0, 15);
  const jul2026 = new Date(2026, 6, 15);

  it('returns student when end_year is in the future', () => {
    const result = deriveContactStatusFromDB([{ end_year: 2028 }], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2028');
  });

  it('returns student when end_year is current year and before July', () => {
    const result = deriveContactStatusFromDB([{ end_year: 2026 }], jan2026);
    expect(result.contact_status).toBe('student');
  });

  it('returns professional when end_year is current year and July or later', () => {
    const result = deriveContactStatusFromDB([{ end_year: 2026 }], jul2026);
    expect(result.contact_status).toBe('professional');
  });

  it('returns professional when end_year is in the past', () => {
    const result = deriveContactStatusFromDB([{ end_year: 2020 }], jan2026);
    expect(result.contact_status).toBe('professional');
  });

  it('returns professional for null end_year', () => {
    const result = deriveContactStatusFromDB([{ end_year: null }], jan2026);
    expect(result.contact_status).toBe('professional');
  });

  it('returns professional for empty education', () => {
    const result = deriveContactStatusFromDB([], jan2026);
    expect(result.contact_status).toBe('professional');
  });

  it('uses the latest end_year when multiple entries exist', () => {
    const result = deriveContactStatusFromDB([
      { end_year: 2020 },
      { end_year: 2028 },
    ], jan2026);
    expect(result.contact_status).toBe('student');
    expect(result.expected_graduation).toBe('2028');
  });

  it('ignores null entries when other valid entries exist', () => {
    const result = deriveContactStatusFromDB([
      { end_year: null },
      { end_year: 2028 },
    ], jan2026);
    expect(result.contact_status).toBe('student');
  });
});

describe('shouldRederiveStatus', () => {
  it('returns true when statusDerivedAt is null', () => {
    expect(shouldRederiveStatus(null)).toBe(true);
  });

  it('returns true for invalid date string', () => {
    expect(shouldRederiveStatus('not-a-date')).toBe(true);
  });

  it('returns true when derived in previous H2 and now is January', () => {
    // Derived in Nov 2025, now is Jan 2026 — crossed Jan 1 boundary
    const now = new Date(2026, 0, 15); // Jan 15, 2026
    expect(shouldRederiveStatus('2025-11-01T00:00:00Z', now)).toBe(true);
  });

  it('returns true when derived in H1 and now is July', () => {
    // Derived in Mar 2026, now is Jul 2026 — crossed Jul 1 boundary
    const now = new Date(2026, 6, 15); // Jul 15, 2026
    expect(shouldRederiveStatus('2026-03-01T00:00:00Z', now)).toBe(true);
  });

  it('returns false when derived after the most recent Jan boundary', () => {
    // Derived Feb 2026, now is Mar 2026 — still in same H1 period
    const now = new Date(2026, 2, 15); // Mar 15, 2026
    expect(shouldRederiveStatus('2026-02-01T00:00:00Z', now)).toBe(false);
  });

  it('returns false when derived after the most recent Jul boundary', () => {
    // Derived Aug 2026, now is Oct 2026 — still in same H2 period
    const now = new Date(2026, 9, 15); // Oct 15, 2026
    expect(shouldRederiveStatus('2026-08-01T00:00:00Z', now)).toBe(false);
  });

  it('returns false when derived exactly on the Jan boundary', () => {
    const now = new Date(2026, 2, 15); // Mar 15, 2026
    const derived = new Date(2026, 0, 1); // Jan 1, 2026 local
    expect(shouldRederiveStatus(derived, now)).toBe(false);
  });

  it('returns false when derived exactly on the Jul boundary', () => {
    const now = new Date(2026, 8, 15); // Sep 15, 2026
    const derived = new Date(2026, 6, 1); // Jul 1, 2026 local
    expect(shouldRederiveStatus(derived, now)).toBe(false);
  });

  it('returns true on edge: derived Dec 31, now is Jan 1', () => {
    const now = new Date(2026, 0, 1, 0, 1); // Jan 1, 2026 00:01
    expect(shouldRederiveStatus('2025-12-31T23:59:00Z', now)).toBe(true);
  });

  it('returns true on edge: derived Jun 30, now is Jul 1', () => {
    const now = new Date(2026, 6, 1, 0, 1); // Jul 1, 2026 00:01
    expect(shouldRederiveStatus('2026-06-30T23:59:00Z', now)).toBe(true);
  });

  it('accepts Date objects as statusDerivedAt', () => {
    const now = new Date(2026, 2, 15);
    const derived = new Date(2026, 1, 1);
    expect(shouldRederiveStatus(derived, now)).toBe(false);
  });
});

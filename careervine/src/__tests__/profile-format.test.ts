import { describe, it, expect } from 'vitest';

// Panel display helpers, imported from the extension panel via the @panel alias
import {
  standardizeLocation,
  standardizeMonth,
  parseAnyDate,
  calcDuration,
  deriveContactStatus,
} from '@panel/lib/profile-format';

describe('standardizeLocation', () => {
  describe('never invents a country the input did not contain (CAR-42)', () => {
    it('passes through "City, Country" for non-US countries', () => {
      expect(standardizeLocation('London, UK')).toBe('London, UK');
      expect(standardizeLocation('Paris, France')).toBe('Paris, France');
      expect(standardizeLocation('London Area, United Kingdom')).toBe('London Area, United Kingdom');
    });

    it('passes through unrecognized 2-part locations that the old heuristic mangled', () => {
      // Old behavior: "Washington, D.C." -> "Washington, D.C., USA"
      expect(standardizeLocation('Washington, D.C.')).toBe('Washington, D.C.');
    });

    it('leaves 3-part international locations untouched (regression)', () => {
      expect(standardizeLocation('Berlin, Berlin, Germany')).toBe('Berlin, Berlin, Germany');
    });

    it('leaves single-part locations untouched', () => {
      expect(standardizeLocation('San Francisco Bay Area')).toBe('San Francisco Bay Area');
    });
  });

  describe('US locations still normalize to "City, ST, USA"', () => {
    it('abbreviates full state names', () => {
      expect(standardizeLocation('Provo, Utah')).toBe('Provo, UT, USA');
    });

    it('accepts already-abbreviated states', () => {
      expect(standardizeLocation('Provo, UT')).toBe('Provo, UT, USA');
    });

    it('normalizes 3-part US forms', () => {
      expect(standardizeLocation('Salt Lake City, Utah, United States')).toBe('Salt Lake City, UT, USA');
    });

    it('normalizes "City, United States" without inventing a state', () => {
      expect(standardizeLocation('Provo, United States')).toBe('Provo, USA');
    });
  });

  describe('decided tradeoff: bare state-name collisions still read as US states', () => {
    it('treats "Tbilisi, Georgia" as the US state', () => {
      expect(standardizeLocation('Tbilisi, Georgia')).toBe('Tbilisi, GA, USA');
    });
  });

  describe('work arrangements and job types', () => {
    it('keeps work arrangements as-is (capitalized)', () => {
      expect(standardizeLocation('Remote')).toBe('Remote');
      expect(standardizeLocation('hybrid')).toBe('Hybrid');
    });

    it('drops job types — they are not locations', () => {
      expect(standardizeLocation('Full-time')).toBe('');
      expect(standardizeLocation('Internship')).toBe('');
    });
  });

  it('returns "" for empty input', () => {
    expect(standardizeLocation(null)).toBe('');
    expect(standardizeLocation('')).toBe('');
  });
});

describe('parseAnyDate', () => {
  it('parses "Mon YYYY"', () => {
    expect(parseAnyDate('Aug 2024')).toEqual(new Date(2024, 7));
  });

  it('parses "Month YYYY"', () => {
    expect(parseAnyDate('August 2024')).toEqual(new Date(2024, 7));
  });

  it('parses truncated 2-digit years ("September 24")', () => {
    expect(parseAnyDate('September 24')).toEqual(new Date(2024, 8));
  });

  it('parses bare years', () => {
    expect(parseAnyDate('2024')).toEqual(new Date(2024, 0));
  });

  it('returns null for garbage', () => {
    expect(parseAnyDate('not a date')).toBeNull();
  });
});

describe('standardizeMonth', () => {
  it('standardizes full month names to "Mon YYYY"', () => {
    expect(standardizeMonth('August 2024')).toBe('Aug 2024');
  });

  it('keeps "Present" and returns unparseable input unchanged', () => {
    expect(standardizeMonth('Present')).toBe('Present');
    expect(standardizeMonth('sometime')).toBe('sometime');
    expect(standardizeMonth(null)).toBe('');
  });
});

describe('calcDuration', () => {
  const now = new Date(2026, 6, 10); // Jul 10, 2026

  it('formats years and months', () => {
    expect(calcDuration('Aug 2024', 'Jul 2025', now)).toBe('11 mos');
    expect(calcDuration('Aug 2024', 'Sep 2025', now)).toBe('1 yr 1 mos');
    expect(calcDuration('Aug 2023', 'Aug 2024', now)).toBe('1 yr');
  });

  it('uses the injected clock for "Present"', () => {
    expect(calcDuration('Jul 2025', 'Present', now)).toBe('1 yr');
  });

  it('returns "" when either end is missing or unparseable', () => {
    expect(calcDuration(null, 'Jul 2025', now)).toBe('');
    expect(calcDuration('garbage', 'Jul 2025', now)).toBe('');
    expect(calcDuration('Jul 2025', 'garbage', now)).toBe('');
  });
});

describe('deriveContactStatus', () => {
  const now = new Date(2026, 6, 10); // Jul 10, 2026

  it('marks current education as student', () => {
    expect(deriveContactStatus([{ end_year: '2028', is_current: true }], now).contact_status).toBe('student');
  });

  it('is month-aware: "May 2027" is a student until June 2027', () => {
    const result = deriveContactStatus([{ end_year: 'May 2027' }], now);
    expect(result).toEqual({ contact_status: 'student', expected_graduation: 'May 2027' });
  });

  it('year-only grads count as students until July of that year', () => {
    expect(deriveContactStatus([{ end_year: '2026' }], now).contact_status).toBe('professional'); // July 10 >= July 1
    expect(deriveContactStatus([{ end_year: '2027' }], now).contact_status).toBe('student');
  });

  it('past graduation means professional', () => {
    expect(deriveContactStatus([{ end_year: 'May 2024' }], now)).toEqual({
      contact_status: 'professional',
      expected_graduation: null,
    });
  });
});

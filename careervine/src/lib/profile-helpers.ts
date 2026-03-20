/**
 * Pure helpers for post-processing parsed LinkedIn profile data.
 * Extracted for testability.
 */

/** Sentinel value used by the OpenAI parser to mark ongoing roles/education. */
export const CURRENT_MARKER = "Present";

/** Month abbreviations for parsing month+year strings. */
const MONTH_ABBREVS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** Add is_current flag to experience entries based on end_month. */
export function addIsCurrentToExperience(experience: any[]): any[] {
  return experience.map(exp => ({
    ...exp,
    is_current: exp.end_month === CURRENT_MARKER
  }));
}

/** Add is_current flag to education entries based on end_year. */
export function addIsCurrentToEducation(education: any[]): any[] {
  return education.map(edu => ({
    ...edu,
    is_current: edu.end_year === CURRENT_MARKER
  }));
}

/** Derive current_company and current_title from experience list. */
export function deriveCurrentRole(experience: any[]): { current_company: string | null; current_title: string | null } {
  const current = experience.find(exp => exp.is_current);
  return {
    current_company: current?.company || null,
    current_title: current?.title || null,
  };
}

/**
 * Parse an end_year string into a cutoff Date.
 * - "Present" or is_current → null (still enrolled)
 * - "May 2027" → June 1 2027 (end of that month)
 * - "2027" → July 1 2027 (year-only assumes July cutoff)
 * Returns null if the student is currently enrolled, or Date if a cutoff exists.
 */
function parseEducationEnd(endYear: string | null | undefined, isCurrent?: boolean): { cutoff: Date | null; isCurrent: boolean; graduationLabel: string | null } {
  if (isCurrent || endYear === CURRENT_MARKER) {
    return { cutoff: null, isCurrent: true, graduationLabel: null };
  }
  if (!endYear) return { cutoff: null, isCurrent: false, graduationLabel: null };

  const trimmed = String(endYear).trim();

  // Try month+year: "May 2027", "Sep 2026", etc.
  const monthYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const monthIndex = MONTH_ABBREVS[monthYearMatch[1].toLowerCase()];
    const year = parseInt(monthYearMatch[2]);
    if (monthIndex !== undefined && !isNaN(year)) {
      // Cutoff is the first day of the NEXT month after graduation
      const cutoff = new Date(year, monthIndex + 1, 1);
      return { cutoff, isCurrent: false, graduationLabel: trimmed };
    }
  }

  // Try year-only: "2027"
  const yearOnly = parseInt(trimmed);
  if (!isNaN(yearOnly) && yearOnly > 1900) {
    // Year-only: assume student until July 1 of that year
    const cutoff = new Date(yearOnly, 6, 1); // July = month 6
    return { cutoff, isCurrent: false, graduationLabel: String(yearOnly) };
  }

  return { cutoff: null, isCurrent: false, graduationLabel: null };
}

/**
 * Determine contact_status and expected_graduation from education data.
 * Used for fresh scrapes where end_year is a string (may contain month info).
 *
 * Rules:
 * - is_current or "Present" → student
 * - Month+year end (e.g. "May 2027") → student if that month hasn't passed
 * - Year-only end (e.g. "2027") → student if before July of that year
 */
export function deriveContactStatus(
  education: any[],
  now: Date = new Date()
): { contact_status: 'student' | 'professional'; expected_graduation: string | null } {
  let latestGraduationLabel: string | null = null;
  let latestCutoff: Date | null = null;
  let isStudent = false;

  for (const edu of education) {
    const parsed = parseEducationEnd(edu.end_year, edu.is_current);

    if (parsed.isCurrent) {
      isStudent = true;
      continue;
    }

    if (parsed.cutoff && now < parsed.cutoff) {
      isStudent = true;
      if (!latestCutoff || parsed.cutoff > latestCutoff) {
        latestCutoff = parsed.cutoff;
        latestGraduationLabel = parsed.graduationLabel;
      }
    }
  }

  if (isStudent) {
    return { contact_status: 'student', expected_graduation: latestGraduationLabel };
  }
  return { contact_status: 'professional', expected_graduation: null };
}

/**
 * Determine contact_status from DB-stored education (end_year is int, no month).
 * Always uses the July rule for year-only data.
 */
export function deriveContactStatusFromDB(
  education: { end_year: number | null }[],
  now: Date = new Date()
): { contact_status: 'student' | 'professional'; expected_graduation: string | null } {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed, July = 6

  let latestEndYear: number | null = null;

  for (const edu of education) {
    if (edu.end_year == null) continue;

    if (edu.end_year > currentYear) {
      // Future year — definitely still a student
      if (latestEndYear === null || edu.end_year > latestEndYear) {
        latestEndYear = edu.end_year;
      }
    } else if (edu.end_year === currentYear && currentMonth < 6) {
      // Current year, before July — still a student
      if (latestEndYear === null || edu.end_year > latestEndYear) {
        latestEndYear = edu.end_year;
      }
    }
  }

  if (latestEndYear !== null) {
    return { contact_status: 'student', expected_graduation: String(latestEndYear) };
  }
  return { contact_status: 'professional', expected_graduation: null };
}

/**
 * Check whether contact_status should be re-derived based on the last derivation timestamp.
 * Re-derivation happens every January 1 and July 1.
 * Returns true if the most recent Jan/Jul boundary has been crossed since statusDerivedAt.
 */
export function shouldRederiveStatus(statusDerivedAt: string | Date | null, now: Date = new Date()): boolean {
  if (!statusDerivedAt) return true;

  const derivedDate = statusDerivedAt instanceof Date ? statusDerivedAt : new Date(statusDerivedAt);
  if (isNaN(derivedDate.getTime())) return true;

  // Find the most recent Jan 1 or Jul 1 relative to now
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  let boundary: Date;
  if (month >= 6) {
    // July or later — boundary is Jul 1 of this year
    boundary = new Date(year, 6, 1);
  } else {
    // Before July — boundary is Jan 1 of this year
    boundary = new Date(year, 0, 1);
  }

  return derivedDate < boundary;
}

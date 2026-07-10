// Pure display-formatting helpers for the panel. No React, no chrome APIs —
// unit-tested from the careervine suite via the @panel alias.

// Month abbreviations for parsing education end dates
export const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Month abbreviations for standardization
export const MONTH_ABBREVS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// US state abbreviations
export const STATE_ABBREVS: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC"
};

// Structural subset of the panel's Education type — all deriveContactStatus reads.
export type EducationDates = {
  end_year: string | null;
  is_current?: boolean;
};

// Client-side contact status derivation (mirrors backend deriveContactStatus)
// Month-aware: "May 2027" -> student until June 2027; "2027" -> student until July 2027
export const deriveContactStatus = (education: EducationDates[], now: Date = new Date()): { contact_status: 'student' | 'professional'; expected_graduation: string | null } => {
  let isStudent = false;
  let latestGradLabel: string | null = null;
  let latestCutoff: Date | null = null;

  for (const edu of education) {
    if (edu.is_current || edu.end_year === "Present") {
      isStudent = true;
      continue;
    }
    if (!edu.end_year) continue;

    const trimmed = edu.end_year.trim();

    // Try month+year: "May 2027"
    const monthYearMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (monthYearMatch) {
      const mi = MONTH_NAMES[monthYearMatch[1].toLowerCase()];
      const yr = parseInt(monthYearMatch[2]);
      if (mi !== undefined && !isNaN(yr)) {
        const cutoff = new Date(yr, mi + 1, 1);
        if (now < cutoff) {
          isStudent = true;
          if (!latestCutoff || cutoff > latestCutoff) {
            latestCutoff = cutoff;
            latestGradLabel = trimmed;
          }
        }
        continue;
      }
    }

    // Year-only: "2027" -> student until July of that year
    const yearOnly = parseInt(trimmed);
    if (!isNaN(yearOnly) && yearOnly > 1900) {
      const cutoff = new Date(yearOnly, 6, 1); // July 1
      if (now < cutoff) {
        isStudent = true;
        if (!latestCutoff || cutoff > latestCutoff) {
          latestCutoff = cutoff;
          latestGradLabel = trimmed;
        }
      }
    }
  }

  if (isStudent) {
    return { contact_status: 'student', expected_graduation: latestGradLabel };
  }
  return { contact_status: 'professional', expected_graduation: null };
};

// Parse any date format into a Date object
export const parseAnyDate = (dateStr: string): Date | null => {
  if (!dateStr || dateStr === "Present") return dateStr === "Present" ? new Date() : null;

  // Clean up the string
  const cleaned = dateStr.trim();

  // Try "Mon YYYY" format (e.g., "Aug 2024")
  const abbrevMatch = cleaned.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (abbrevMatch) {
    const mi = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === abbrevMatch[1].toLowerCase());
    if (mi !== -1) return new Date(parseInt(abbrevMatch[2]), mi);
  }

  // Try "Month YYYY" format (e.g., "August 2024")
  const fullMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (fullMatch) {
    const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === fullMatch[1].toLowerCase());
    if (mi !== -1) return new Date(parseInt(fullMatch[2]), mi);
  }

  // Try "Month YY" format with truncated 2-digit year (e.g., "September 24" -> "September 2024")
  // Only match numbers > 12 to avoid confusing day-of-month (e.g., "September 4") with years
  const truncatedMatch = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (truncatedMatch) {
    const num = parseInt(truncatedMatch[2]);
    // Numbers 1-31 are ambiguous (could be day-of-month), so only treat > 31 as definite years
    // Numbers 13-31 are also ambiguous but less likely to be years, so skip them too
    // Only treat 2-digit numbers as truncated years (e.g., 24 -> 2024)
    if (num >= 20 && num <= 99) {
      const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === truncatedMatch[1].toLowerCase());
      const miAbbrev = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === truncatedMatch[1].toLowerCase());
      const monthIndex = mi !== -1 ? mi : miAbbrev;
      if (monthIndex !== -1) {
        const year = num + 2000;
        return new Date(year, monthIndex);
      }
    }
  }

  // Try "Mon YYY" format with 3-digit year (e.g., "Dec 202" -> "Dec 2020")
  const threeDigitYear = cleaned.match(/^([A-Za-z]+)\s+(\d{3})$/);
  if (threeDigitYear) {
    const mi = MONTH_FULL.findIndex(m => m.toLowerCase() === threeDigitYear[1].toLowerCase());
    const miAbbrev = MONTH_ABBREVS.findIndex(m => m.toLowerCase() === threeDigitYear[1].toLowerCase());
    const monthIndex = mi !== -1 ? mi : miAbbrev;
    if (monthIndex !== -1) {
      // Assume it's a truncated 4-digit year starting with 202
      const year = parseInt(threeDigitYear[2] + "0");
      return new Date(year, monthIndex);
    }
  }

  // Try just year "YYYY"
  const yearMatch = cleaned.match(/^(\d{4})$/);
  if (yearMatch) return new Date(parseInt(yearMatch[1]), 0);

  return null;
};

// Standardize a date string to "Mon YYYY" format (e.g., "Aug 2024")
export const standardizeMonth = (dateStr: string | null): string => {
  if (!dateStr) return "";
  if (dateStr === "Present") return "Present";

  const date = parseAnyDate(dateStr);
  if (!date) return dateStr; // Return original if can't parse

  return `${MONTH_ABBREVS[date.getMonth()]} ${date.getFullYear()}`;
};

// Calculate duration between two dates and return formatted string
export const calcDuration = (start: string | null, end: string | null, now: Date = new Date()): string => {
  if (!start) return "";

  const startDate = parseAnyDate(start);
  if (!startDate) return "";

  const endDate = end === "Present" ? now : parseAnyDate(end || "");
  if (!endDate) return "";

  const totalMonths = (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth());
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;

  if (years > 0 && months > 0) return `${years} yr ${months} mos`;
  if (years > 0) return `${years} yr`;
  if (months > 0) return `${months} mos`;
  return "";
};

// Standardize location for display. US locations normalize to "City, ST, USA";
// everything else passes through unchanged — never invent a country the input
// didn't contain (CAR-42). Decided tradeoff: bare state-name collisions still
// read as US states ("Tbilisi, Georgia" -> "Tbilisi, GA, USA").
export const standardizeLocation = (location: string | null): string => {
  if (!location) return "";

  // Clean up the string
  const cleaned = location.trim().replace(/\s+/g, ' ');

  // If it's a work arrangement, return as-is
  const workArrangementTypes = ['remote', 'on-site', 'onsite', 'hybrid'];
  if (workArrangementTypes.some(type => cleaned.toLowerCase() === type)) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase(); // Capitalize first letter
  }

  // If it looks like other job types, return empty (these aren't locations)
  const jobTypes = ['internship', 'contract', 'freelance', 'part-time', 'full-time', 'temporary', 'remote work', 'on site', 'self-employed', 'self employed'];
  if (jobTypes.some(jobType => cleaned.toLowerCase().includes(jobType))) {
    return "";
  }

  // Split by comma and clean up
  const parts = cleaned.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return cleaned;

  const city = parts[0];
  let state: string | null = null;
  let country: string | null = null;

  if (parts.length >= 3) {
    // Assume: City, State, Country
    state = parts[1];
    country = parts[2];
  } else if (parts.length === 2) {
    const second = parts[1];
    const secondLower = second.toLowerCase();
    const isUsState = Boolean(STATE_ABBREVS[secondLower]) || Object.values(STATE_ABBREVS).includes(second.toUpperCase());
    const isUsSynonym = secondLower.includes("united states") || secondLower === "usa" || secondLower === "us";
    if (isUsState) {
      state = second;
      country = "USA";
    } else if (isUsSynonym) {
      country = "USA";
    } else {
      // Not recognizably US — pass through unchanged
      return cleaned;
    }
  }
  // parts.length === 1: single city name — no state, no country

  // Abbreviate state if full name
  const stateLower = state?.toLowerCase();
  if (stateLower && STATE_ABBREVS[stateLower]) {
    state = STATE_ABBREVS[stateLower];
  }

  // Standardize country
  if (country) {
    const countryLower = country.toLowerCase();
    if (countryLower.includes("united states") || countryLower === "us" || countryLower === "usa") {
      country = "USA";
    }
  }

  // Build result
  const result = [city, state, country].filter(Boolean).join(", ");
  return result || cleaned;
};

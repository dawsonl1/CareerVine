/**
 * Canonical US state reference — the single source of truth shared by the
 * location normalizer (scrape/import pipeline) and the manual contact-entry
 * forms, so hand-entered and imported states normalize to the SAME value.
 *
 * Canonical stored form is the full state name (e.g. "California"), matching
 * everything `location-normalizer.ts` produces. `findOrCreateLocation` matches
 * locations on exact `state` equality, so a shared canonical form is what keeps
 * "the same place" from splitting into duplicate rows.
 */

/** 2-letter code → canonical full name (50 states + DC). */
export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

/** Lowercased full name → canonical full name, for case-insensitive name lookups. */
const NAME_TO_CANONICAL = new Map<string, string>(
  Object.values(US_STATES).map((name) => [name.toLowerCase(), name]),
);

/**
 * Dropdown options for a normalized state picker: value and label are both the
 * canonical full name, sorted A–Z.
 */
export const US_STATE_OPTIONS: { value: string; label: string }[] = Object.values(US_STATES)
  .sort((a, b) => a.localeCompare(b))
  .map((name) => ({ value: name, label: name }));

/**
 * Map a 2-letter code or a full name (any case, tolerant of dots in codes like
 * "N.Y.") to the canonical full state name. Returns null for anything not a
 * recognized US state, so callers can preserve unrecognized free text as-is.
 */
export function canonicalUsState(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const code = s.toUpperCase().replace(/\./g, "");
  if (US_STATES[code]) return US_STATES[code];
  return NAME_TO_CANONICAL.get(s.toLowerCase()) ?? null;
}

/** Country strings that denote the United States. Empty defaults to US. */
const US_COUNTRY_ALIASES = new Set([
  "", "united states", "united states of america", "usa", "us", "u.s.", "u.s.a.", "america",
]);

/**
 * Whether a country value denotes the United States (so the normalized state
 * dropdown applies). Empty/unset counts as US since the forms default country
 * to "United States".
 */
export function isUnitedStates(country: string | null | undefined): boolean {
  return US_COUNTRY_ALIASES.has((country ?? "").trim().toLowerCase());
}

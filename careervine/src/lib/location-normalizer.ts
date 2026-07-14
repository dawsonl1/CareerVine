/**
 * Deterministic location-string normalizer for scraped LinkedIn data.
 *
 * Converts free-text location strings ("Greater San Diego Area",
 * "Seattle, Washington, United States", "La Jolla, CA") into canonical
 * metro-grain values matching the locations table (city / state / country),
 * and classifies granularity: only city-grain results may establish company
 * offices (import rule 1). Country/state/region-grain strings normalize for
 * display but return canEstablishOffice: false.
 *
 * The alias map is a seed (US major metros + known suburb collapses) —
 * expand from real scrape data as unparsed strings surface. Unparseable
 * input → granularity 'unknown' with the raw string kept by the caller.
 */

import { US_STATES } from "./us-states";

export type LocationGranularity = "city" | "state" | "country" | "region" | "unknown";

export interface NormalizedLocation {
  city: string | null;
  state: string | null;
  country: string | null;
  granularity: LocationGranularity;
  /** Only city-grain locations may establish company_locations rows. */
  canEstablishOffice: boolean;
  /** A "remote" marker was present in the string (workplaceType is the other signal). */
  isRemote: boolean;
  raw: string;
}

// ── Reference data ─────────────────────────────────────────────────────
// US_STATES (code → canonical full name) lives in ./us-states — the single
// source shared with the manual contact-entry state dropdown.

const US_STATE_NAMES = new Set(Object.values(US_STATES).map((s) => s.toLowerCase()));

/** Country synonyms → canonical name (matches locations.country conventions). */
const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "United States",
  "united states of america": "United States",
  usa: "United States",
  us: "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  "united kingdom": "United Kingdom",
  uk: "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  canada: "Canada",
  germany: "Germany",
  france: "France",
  india: "India",
  ireland: "Ireland",
  netherlands: "Netherlands",
  australia: "Australia",
  singapore: "Singapore",
  japan: "Japan",
  brazil: "Brazil",
  mexico: "Mexico",
  israel: "Israel",
  switzerland: "Switzerland",
  poland: "Poland",
  spain: "Spain",
  italy: "Italy",
  sweden: "Sweden",
};

/** Supra-national / vague-region tokens — never establish offices. */
const REGION_TOKENS = new Set([
  "emea", "apac", "latam", "amer", "americas", "north america", "south america",
  "europe", "asia", "africa", "middle east", "asia pacific", "worldwide", "global",
  "earth", "international",
]);

/**
 * Metro alias map: LinkedIn metro strings and known suburbs → canonical
 * metro city + state. Collapsing is deliberately conservative — distinct
 * office cities (Mountain View vs Sunnyvale vs SF) stay distinct; only
 * unambiguous metro-area strings and neighborhood/suburb-of-city cases
 * collapse. Keys are lowercase.
 */
const METRO_ALIASES: Record<string, { city: string; state: string }> = {
  // LinkedIn "Greater X Area" / metro strings that don't parse as City, State
  "san francisco bay area": { city: "San Francisco", state: "California" },
  "bay area": { city: "San Francisco", state: "California" },
  "silicon valley": { city: "San Francisco", state: "California" },
  "new york city metropolitan area": { city: "New York", state: "New York" },
  "greater new york city area": { city: "New York", state: "New York" },
  "washington dc-baltimore area": { city: "Washington", state: "District of Columbia" },
  "washington dc metro area": { city: "Washington", state: "District of Columbia" },
  "dallas-fort worth metroplex": { city: "Dallas", state: "Texas" },
  "greater minneapolis-st. paul area": { city: "Minneapolis", state: "Minnesota" },
  "raleigh-durham-chapel hill area": { city: "Raleigh", state: "North Carolina" },
  "greater salt lake city area": { city: "Salt Lake City", state: "Utah" },
  "salt lake city metropolitan area": { city: "Salt Lake City", state: "Utah" },
  // Neighborhood / suburb → metro city collapses (same office market)
  "la jolla": { city: "San Diego", state: "California" },
  brooklyn: { city: "New York", state: "New York" },
  manhattan: { city: "New York", state: "New York" },
  "new york city": { city: "New York", state: "New York" },
  nyc: { city: "New York", state: "New York" },
  "santa monica": { city: "Los Angeles", state: "California" },
  "venice beach": { city: "Los Angeles", state: "California" },
  hollywood: { city: "Los Angeles", state: "California" },
  "st. paul": { city: "Minneapolis", state: "Minnesota" },
  "saint paul": { city: "Minneapolis", state: "Minnesota" },
  cambridge: { city: "Boston", state: "Massachusetts" },
  // Utah / Silicon Slopes towns commonly written without state
  "silicon slopes": { city: "Lehi", state: "Utah" },
};

/** Cities whose metro is unambiguous without a state (for "Greater X Area"). */
const KNOWN_METRO_CITIES: Record<string, { city: string; state: string }> = {
  "san diego": { city: "San Diego", state: "California" },
  seattle: { city: "Seattle", state: "Washington" },
  "los angeles": { city: "Los Angeles", state: "California" },
  chicago: { city: "Chicago", state: "Illinois" },
  boston: { city: "Boston", state: "Massachusetts" },
  denver: { city: "Denver", state: "Colorado" },
  atlanta: { city: "Atlanta", state: "Georgia" },
  austin: { city: "Austin", state: "Texas" },
  houston: { city: "Houston", state: "Texas" },
  dallas: { city: "Dallas", state: "Texas" },
  phoenix: { city: "Phoenix", state: "Arizona" },
  philadelphia: { city: "Philadelphia", state: "Pennsylvania" },
  portland: { city: "Portland", state: "Oregon" },
  "salt lake city": { city: "Salt Lake City", state: "Utah" },
  "st. louis": { city: "St. Louis", state: "Missouri" },
  minneapolis: { city: "Minneapolis", state: "Minnesota" },
  detroit: { city: "Detroit", state: "Michigan" },
  miami: { city: "Miami", state: "Florida" },
  nashville: { city: "Nashville", state: "Tennessee" },
  "kansas city": { city: "Kansas City", state: "Missouri" },
  pittsburgh: { city: "Pittsburgh", state: "Pennsylvania" },
  "new york": { city: "New York", state: "New York" },
  "san francisco": { city: "San Francisco", state: "California" },
  "washington": { city: "Washington", state: "District of Columbia" },
  london: { city: "London", state: "" },
  toronto: { city: "Toronto", state: "Ontario" },
  vancouver: { city: "Vancouver", state: "British Columbia" },
  dublin: { city: "Dublin", state: "" },
};

// ── Helpers ────────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function lookupState(token: string): string | null {
  const upper = token.trim().toUpperCase().replace(/\./g, "");
  if (US_STATES[upper]) return US_STATES[upper];
  const lower = token.trim().toLowerCase();
  if (US_STATE_NAMES.has(lower)) return titleCase(lower);
  return null;
}

function lookupCountry(token: string): string | null {
  return COUNTRY_ALIASES[token.trim().toLowerCase()] ?? null;
}

function applyMetroAlias(city: string, state: string | null): { city: string; state: string | null } {
  const alias = METRO_ALIASES[city.trim().toLowerCase()];
  if (alias) return { city: alias.city, state: alias.state };
  return { city: titleCase(city.trim()), state };
}

const REMOTE_RE = /\(?\bremote\b\)?/gi;

function unknown(raw: string, isRemote: boolean): NormalizedLocation {
  return { city: null, state: null, country: null, granularity: "unknown", canEstablishOffice: false, isRemote, raw };
}

function cityResult(raw: string, isRemote: boolean, city: string, state: string | null, country: string): NormalizedLocation {
  return { city, state: state || null, country, granularity: "city", canEstablishOffice: true, isRemote, raw };
}

// ── Main entry points ──────────────────────────────────────────────────

/**
 * Normalize a free-text location string from a scraped LinkedIn profile
 * or experience entry.
 */
export function normalizeLocation(input: string | null | undefined): NormalizedLocation {
  const raw = (input ?? "").trim();
  if (!raw) return unknown(raw, false);

  const isRemote = REMOTE_RE.test(raw);
  REMOTE_RE.lastIndex = 0;
  let s = raw.replace(REMOTE_RE, " ").replace(/\s+/g, " ").replace(/^[\s,·|-]+|[\s,·|-]+$/g, "").trim();
  if (!s) return unknown(raw, isRemote);

  const lower = s.toLowerCase();

  // Vague regions: "EMEA", "Asia Pacific", ...
  if (REGION_TOKENS.has(lower)) {
    return { city: null, state: null, country: null, granularity: "region", canEstablishOffice: false, isRemote, raw };
  }

  // Whole-string metro aliases: "San Francisco Bay Area", "Silicon Slopes"
  const wholeAlias = METRO_ALIASES[lower];
  if (wholeAlias) return cityResult(raw, isRemote, wholeAlias.city, wholeAlias.state, "United States");

  // "Greater X Area" / "X Metropolitan Area" / "X Metro Area"
  const metroMatch =
    lower.match(/^greater\s+(.+?)\s+area$/) ||
    lower.match(/^(.+?)\s+metropolitan\s+area$/) ||
    lower.match(/^(.+?)\s+metro\s+area$/) ||
    lower.match(/^greater\s+(.+)$/);
  if (metroMatch) {
    const core = metroMatch[1].trim();
    const known = KNOWN_METRO_CITIES[core] || METRO_ALIASES[core];
    if (known) {
      const country = known.state && US_STATE_NAMES.has(known.state.toLowerCase()) ? "United States" : inferCountryForKnownCity(core);
      return cityResult(raw, isRemote, known.city, known.state || null, country);
    }
    // Unknown metro core — recurse on the core (may be "City, State")
    const inner = normalizeLocation(core);
    if (inner.granularity === "city") return { ...inner, raw, isRemote: isRemote || inner.isRemote };
    return unknown(raw, isRemote);
  }

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    // "City, State, Country" (extra leading segments: keep the last three)
    const [cityPart, statePart, countryPart] = parts.slice(-3);
    const country = lookupCountry(countryPart) ?? titleCase(countryPart);
    const state = lookupState(statePart) ?? (titleCase(statePart) || null);
    const collapsed = applyMetroAlias(cityPart, state);
    return cityResult(raw, isRemote, collapsed.city, collapsed.state, country);
  }

  if (parts.length === 2) {
    const [first, second] = parts;
    const secondAsState = lookupState(second);
    const secondAsCountry = lookupCountry(second);

    // "State, United States" → state grain
    const firstAsState = lookupState(first);
    if (firstAsState && secondAsCountry) {
      return { city: null, state: firstAsState, country: secondAsCountry, granularity: "state", canEstablishOffice: false, isRemote, raw };
    }
    // "City, ST" / "City, State" → city grain (US)
    if (secondAsState) {
      const collapsed = applyMetroAlias(first, secondAsState);
      return cityResult(raw, isRemote, collapsed.city, collapsed.state, "United States");
    }
    // "City, Country"
    if (secondAsCountry) {
      const collapsed = applyMetroAlias(first, null);
      return cityResult(raw, isRemote, collapsed.city, collapsed.state, secondAsCountry);
    }
    // "City, Region-we-don't-know" — treat second as country-ish text
    const collapsed = applyMetroAlias(first, null);
    return cityResult(raw, isRemote, collapsed.city, collapsed.state, titleCase(second));
  }

  // Single token
  const single = parts[0] ?? s;
  const asCountry = lookupCountry(single);
  if (asCountry) {
    return { city: null, state: null, country: asCountry, granularity: "country", canEstablishOffice: false, isRemote, raw };
  }
  const asState = lookupState(single);
  if (asState) {
    return { city: null, state: asState, country: "United States", granularity: "state", canEstablishOffice: false, isRemote, raw };
  }
  const knownCity = KNOWN_METRO_CITIES[single.toLowerCase()] || METRO_ALIASES[single.toLowerCase()];
  if (knownCity) {
    const country = knownCity.state && US_STATE_NAMES.has(knownCity.state.toLowerCase()) ? "United States" : inferCountryForKnownCity(single.toLowerCase());
    return cityResult(raw, isRemote, knownCity.city, knownCity.state || null, country);
  }
  // Unrecognized single token: too ambiguous to establish an office
  return unknown(raw, isRemote);
}

/** Countries for known non-US metro cities (used when state is empty). */
function inferCountryForKnownCity(coreLower: string): string {
  const map: Record<string, string> = {
    london: "United Kingdom",
    dublin: "Ireland",
    toronto: "Canada",
    vancouver: "Canada",
  };
  return map[coreLower] ?? "United States";
}

/**
 * Normalize an already-parsed location object (the actor's
 * location.parsed {city, state, country}) — applies the same alias
 * collapsing and granularity classification as the string path.
 */
export function normalizeParsedLocation(parsed: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): NormalizedLocation {
  const city = parsed.city?.trim() || null;
  const state = parsed.state?.trim() || null;
  const country = parsed.country?.trim() || null;
  const raw = [city, state, country].filter(Boolean).join(", ");

  if (city) {
    const canonicalState = state ? (lookupState(state) ?? titleCase(state)) : null;
    const collapsed = applyMetroAlias(city, canonicalState);
    const canonicalCountry = country ? (lookupCountry(country) ?? titleCase(country)) : (canonicalState && US_STATE_NAMES.has(canonicalState.toLowerCase()) ? "United States" : null);
    return cityResult(raw, false, collapsed.city, collapsed.state, canonicalCountry ?? "United States");
  }
  if (state) {
    const canonicalState = lookupState(state) ?? titleCase(state);
    const canonicalCountry = country ? (lookupCountry(country) ?? titleCase(country)) : "United States";
    return { city: null, state: canonicalState, country: canonicalCountry, granularity: "state", canEstablishOffice: false, isRemote: false, raw };
  }
  if (country) {
    const canonicalCountry = lookupCountry(country) ?? titleCase(country);
    return { city: null, state: null, country: canonicalCountry, granularity: "country", canEstablishOffice: false, isRemote: false, raw };
  }
  return unknown(raw, false);
}

/**
 * Stable comparison key for rule-2 matching: two locations match when their
 * normalized (city, state, country) triples are equal. Returns null for
 * anything that can't establish/match an office.
 */
export function locationMatchKey(loc: NormalizedLocation): string | null {
  if (loc.granularity !== "city" || !loc.city) return null;
  return [loc.city.toLowerCase(), (loc.state ?? "").toLowerCase(), (loc.country ?? "").toLowerCase()].join("|");
}

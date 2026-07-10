/** US state / territory name → 2-letter code (lowercase keys for lookup). */
const US_STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

export function usStateCode(state: string): string | null {
  const trimmed = state.trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return US_STATE_CODES[trimmed.toLowerCase()] ?? null;
}

/**
 * Compact office label for tabs: "Plano, TX" or "London, United Kingdom".
 * US states → 2-letter code; otherwise full country name.
 */
export function formatOfficeTabLabel(
  city: string | null,
  state: string | null,
  country: string | null,
): string {
  const code = state ? usStateCode(state) : null;
  if (code) {
    return city ? `${city}, ${code}` : code;
  }
  const region = country?.trim() || state?.trim();
  if (!region && !city) return "Unknown";
  if (city && region) return `${city}, ${region}`;
  return city ?? region ?? "Unknown";
}

/** Location suffix for a person row in a company roster list. */
export function formatRoleLocationInList(role: {
  location_city?: string | null;
  location_state?: string | null;
  location_country?: string | null;
  location_label?: string | null;
  workplace_type?: string | null;
}): string | null {
  if (role.workplace_type === "remote") return "Remote";
  const compact = formatOfficeTabLabel(
    role.location_city ?? null,
    role.location_state ?? null,
    role.location_country ?? null,
  );
  if (compact !== "Unknown") return compact;
  return role.location_label ?? null;
}

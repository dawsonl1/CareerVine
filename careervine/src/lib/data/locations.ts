/**
 * Canonical locations find-or-create (CAR-155).
 *
 * THE chokepoint for locations rows: normalization runs INSIDE this function
 * (completing CAR-139/F27 structurally), so no writer can create a raw
 * variant row — 'CA' and 'California', metro aliases, and case variants all
 * collapse onto one canonical (city, state, country) tuple. The previous
 * copies (src/lib/data/contacts.ts and src/lib/company-helpers.ts) both
 * delegate here.
 *
 * Normalization is idempotent, so callers that already normalize (the
 * import/bulk pipelines) are unaffected.
 */

import { db, must, type QueryClient } from "./client";
import { normalizeParsedLocation } from "@/lib/location-normalizer";

export interface LocationRow {
  id: number;
  city: string | null;
  state: string | null;
  country: string;
}

/**
 * Normalize the input and find-or-create its canonical locations row.
 * Returns null when nothing normalizes out of the input (no row to link).
 *
 * NULL-aware probe: UNIQUE(city,state,country) is NULLS DISTINCT, so
 * NULL-component tuples can legitimately hold more than one historical row;
 * order("id").limit(1) picks a stable winner. Concurrent saves of the same
 * non-NULL tuple race on the unique constraint: the loser refetches the
 * winner's row instead of failing the whole save.
 */
export async function findOrCreateLocation(
  location: { city?: string | null; state?: string | null; country?: string | null },
  opts: { client?: QueryClient } = {},
): Promise<LocationRow | null> {
  const client = opts.client ?? db();
  const norm = normalizeParsedLocation(location);
  if (!norm.city && !norm.state && !norm.country) return null;

  const city = norm.city;
  const state = norm.state;
  const country = norm.country || "United States";

  const probe = () => {
    let query = client.from("locations").select("*");
    query = city ? query.eq("city", city) : query.is("city", null);
    query = state ? query.eq("state", state) : query.is("state", null);
    return query.eq("country", country).order("id").limit(1).maybeSingle();
  };

  // must(): an errored probe must not fall through to the insert and
  // create a duplicate row.
  const existing = must(await probe());
  if (existing) return existing;

  const { data, error } = await client
    .from("locations")
    .insert({ city, state, country })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      const winner = must(await probe());
      if (winner) return winner;
    }
    throw error;
  }
  return data;
}

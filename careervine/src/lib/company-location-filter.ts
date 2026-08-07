/**
 * Location facet for the Companies page (CAR-251).
 *
 * Split from `company-filters.ts` because this facet is the only one that is
 * not a flat enum: its values form a two-level state → city tree, it needs an
 * option index built from the data, and it feeds SCOPED COUNTS as well as row
 * matching. Keeping that in the filter module would have doubled its size for
 * one facet.
 *
 * ── Why location and not "tier" ──────────────────────────────────────────
 * The filter this replaces read `target_companies.tier`, which only one ops
 * script ever wrote. Offices come from `company_locations`, which the scrape
 * importer and the add-company form both populate, so the filter works for a
 * user with no data bundle and no targets.
 *
 * ── Value encoding ──────────────────────────────────────────────────────
 *   `c:<location_id>`  one city
 *   `s:<group>`        every city in a state (or country, where a location has
 *                      no state, e.g. "Rumst, Belgium")
 *   `none`             companies with no recorded office at all
 *
 * A state value is stored as the STATE, never expanded into its cities at
 * selection time. Expanding would freeze the selection against the data as it
 * looked when clicked: adding an office in a new Utah city later would leave a
 * "Utah" selection silently not matching it. Matching resolves the state on
 * every evaluation instead.
 */

import type { CompanyBaseSummary, CompanySummary, CompanyOfficeSummary } from "./company-queries";

/** Companies with no office row at all — the deliberate escape hatch. */
export const NO_LOCATION = "none";

export const cityValue = (locationId: number) => `c:${locationId}`;
export const stateValue = (group: string) => `s:${group}`;

/**
 * The group an office belongs to: its state, or its country when there is no
 * state. US locations always carry a state; international ones frequently do
 * not, and grouping those under "United Kingdom" beats a blank header.
 */
export const officeGroup = (o: Pick<CompanyOfficeSummary, "state" | "country">): string =>
  o.state?.trim() || o.country?.trim() || "Other";

/** One city row inside a state group. */
export interface LocationCityOption {
  value: string;
  label: string;
  /** Companies with an office here. */
  count: number;
}

/** A state (or country) and every city under it. */
export interface LocationGroupOption {
  value: string;
  label: string;
  /** Distinct companies with an office anywhere in the group. */
  count: number;
  cities: LocationCityOption[];
}

/**
 * Build the dropdown's option tree from the loaded companies.
 *
 * Computed over the WHOLE list, never the filtered view — options that vanish
 * as you filter make the control feel broken, which is the same reasoning the
 * status chips use.
 *
 * Group counts are distinct COMPANIES, not the sum of their city counts: a
 * company with offices in both Lehi and Provo is one company in Utah, and a
 * header reading 2 there would overstate what clicking it returns.
 */
export function locationOptions(rows: CompanyBaseSummary[]): LocationGroupOption[] {
  const groups = new Map<string, { cities: Map<number, { label: string; ids: Set<number> }>; companies: Set<number> }>();
  for (const c of rows) {
    for (const o of c.offices) {
      const g = officeGroup(o);
      let entry = groups.get(g);
      if (!entry) {
        entry = { cities: new Map(), companies: new Set() };
        groups.set(g, entry);
      }
      entry.companies.add(c.id);
      const city = entry.cities.get(o.location_id) ?? { label: o.label, ids: new Set<number>() };
      city.ids.add(c.id);
      entry.cities.set(o.location_id, city);
    }
  }
  return [...groups]
    .map(([group, entry]) => ({
      value: stateValue(group),
      label: group,
      count: entry.companies.size,
      cities: [...entry.cities]
        .map(([locationId, city]) => ({
          value: cityValue(locationId),
          label: city.label,
          count: city.ids.size,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Companies carrying no office row, for the `none` option's count. */
export function noLocationCount(rows: CompanyBaseSummary[]): number {
  return rows.filter((c) => c.offices.length === 0).length;
}

/**
 * A parsed selection. Built once per filter change and reused across every row,
 * so matching never re-parses the string values.
 */
export interface LocationSelection {
  cities: Set<number>;
  groups: Set<string>;
  none: boolean;
  /**
   * True whenever the user supplied ANY value, including values this parser
   * could not make sense of.
   *
   * Deliberately not "we recognised at least one value". A shared link whose
   * only `loc` value is malformed, or names a city absent from the recipient's
   * data, must narrow to nothing — not silently fall back to an unfiltered list
   * that looks exactly like the sender's view with a different row count.
   */
  active: boolean;
}

/** The no-filter selection, for callers that render a card outside the list. */
export const EMPTY_SELECTION: LocationSelection = {
  cities: new Set(),
  groups: new Set(),
  none: false,
  active: false,
};

export function parseLocationSelection(values: string[]): LocationSelection {
  const cities = new Set<number>();
  const groups = new Set<string>();
  let none = false;
  for (const v of values) {
    if (v === NO_LOCATION) none = true;
    else if (v.startsWith("c:")) {
      const id = Number(v.slice(2));
      if (Number.isInteger(id)) cities.add(id);
    } else if (v.startsWith("s:")) {
      const g = v.slice(2).trim();
      if (g) groups.add(g);
    }
  }
  return { cities, groups, none, active: values.length > 0 };
}

/** Does this office fall inside the selection? */
function officeSelected(o: CompanyOfficeSummary, sel: LocationSelection): boolean {
  return sel.cities.has(o.location_id) || sel.groups.has(officeGroup(o));
}

/** The company's offices that the selection picks out. */
export function matchedOffices(
  c: Pick<CompanyBaseSummary, "offices">,
  sel: LocationSelection,
): CompanyOfficeSummary[] {
  if (!sel.active) return [];
  return c.offices.filter((o) => officeSelected(o, sel));
}

/** Row matching: any office in the selection, or no offices at all under `none`. */
export function matchesLocation(c: Pick<CompanyBaseSummary, "offices">, sel: LocationSelection): boolean {
  if (!sel.active) return true;
  if (sel.none && c.offices.length === 0) return true;
  return c.offices.some((o) => officeSelected(o, sel));
}

/**
 * Counts restricted to the selected offices, plus the remainder the selection
 * cannot see.
 *
 * `unknown` is the load-bearing field. Only about half of current roles carry a
 * location at all, so a card that showed only the scoped number would routinely
 * read "1 person" at a company where nine contacts work — indistinguishable
 * from a company where one person works. Naming the remainder is what keeps the
 * scoped count honest.
 *
 * Every count is a DISTINCT CONTACT across the selected offices, never a sum
 * over them: 493 contacts on the reference account hold roles at two or more
 * different offices of the same company, and summing counts each of them twice.
 */
export interface ScopedCounts {
  current: number;
  former: number;
  bench: number;
  alum: number;
  product_alum: number;
  recruiter: number;
  /** Contacts here whose office is unrecorded (or remote), so outside any city. */
  unknown: number;
}

export function scopedCounts(c: CompanySummary, sel: LocationSelection): ScopedCounts {
  const offices = new Map(c.offices.map((o) => [o.location_id, o]));
  const inScope = (locationId: number | null) => {
    if (locationId == null) return false;
    const o = offices.get(locationId);
    return o ? officeSelected(o, sel) : false;
  };

  const current = new Set<number>();
  const former = new Set<number>();
  const bench = new Set<number>();
  const alum = new Set<number>();
  const productAlum = new Set<number>();
  const recruiter = new Set<number>();
  // Located-anywhere is tracked so a contact who IS placed, just not here, is
  // not miscounted as "unknown" — the remainder must mean "we don't know", not
  // "they're somewhere else".
  const placed = new Set<number>();
  const everyone = new Set<number>();

  for (const r of c.roster) {
    everyone.add(r.contact_id);
    if (r.location_id != null) placed.add(r.contact_id);
    if (!inScope(r.location_id)) continue;
    if (r.bench) {
      bench.add(r.contact_id);
      continue;
    }
    if (r.is_current) {
      current.add(r.contact_id);
      if (r.alum) alum.add(r.contact_id);
      if (r.product_alum) productAlum.add(r.contact_id);
      if (r.recruiter) recruiter.add(r.contact_id);
    } else {
      former.add(r.contact_id);
    }
  }
  // A boomeranger is current, not former — the same collapse getCompanies
  // applies company-wide, re-applied per scope.
  for (const id of current) former.delete(id);

  let unknown = 0;
  for (const id of everyone) if (!placed.has(id)) unknown++;

  return {
    current: current.size,
    former: former.size,
    bench: bench.size,
    alum: alum.size,
    product_alum: productAlum.size,
    recruiter: recruiter.size,
    unknown,
  };
}

/**
 * Which office the card should open, or null for the company-wide page.
 *
 * Pre-select only when the selection resolves to EXACTLY ONE of this company's
 * offices. Two matched offices means the card's counts are a union of both, and
 * landing on one of them would show the user a different number than the one
 * they just clicked. This is also what makes a state click behave: picking
 * "Massachusetts" opens a company's sole Boston office, but opens a two-office
 * company company-wide.
 */
export function preselectedOffice(
  c: Pick<CompanyBaseSummary, "offices">,
  sel: LocationSelection,
): CompanyOfficeSummary | null {
  const matched = matchedOffices(c, sel);
  return matched.length === 1 ? matched[0] : null;
}

/** `/companies/123` or `/companies/123?location=456`. */
export function companyHref(
  c: Pick<CompanyBaseSummary, "id" | "offices">,
  sel: LocationSelection,
): string {
  const office = preselectedOffice(c, sel);
  return office ? `/companies/${c.id}?location=${office.location_id}` : `/companies/${c.id}`;
}

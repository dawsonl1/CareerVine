/**
 * Pure search/filter logic for the Companies page (CAR-32).
 * Kept free of React/Supabase so it can be unit-tested in the node env.
 *
 * FACET CONTRACT (CAR-245). Every multi-value facet holds an array where **empty
 * means any** — the absence of a filter, never "match nothing". Values inside one
 * facet OR together; facets AND with each other. That is what makes the two
 * complementary pairs (`contacts` with/none, `alumni` with/without) need no special
 * case: selecting both sides ORs to everything, which is the same result as
 * selecting neither.
 *
 * Most facets read a field `getCompanies` already returns. The location facet
 * (CAR-251) is the exception and the reason that used to say "every": it reads
 * `offices`, an office-registry join added to `getCompanies` for it. Its value
 * grammar, option tree and scoped counts live in `company-location-filter.ts`.
 */

import type { CompanySummary } from "./company-queries";
import { matchesLocation, parseLocationSelection } from "./company-location-filter";
import { STAGE_ORDER, type OutreachStage } from "./stage-derivation";

export const TARGET_STATUSES = [
  "researching",
  "outreach_active",
  "applied",
  "interviewing",
  "closed",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** `with` = at least one current or former contact; `none` = neither. */
export const CONTACTS_FILTERS = ["with", "none"] as const;
export type ContactsFilter = (typeof CONTACTS_FILTERS)[number];

/**
 * `with` = at least one alum of the user's school among CURRENT contacts, which is
 * what `alum_count` counts and what the company card badges. Meaningless without
 * school affinity (`alum_count` is 0 for everyone), so the control is hidden there.
 */
export const ALUMNI_FILTERS = ["with", "without"] as const;
export type AlumniFilter = (typeof ALUMNI_FILTERS)[number];

export interface CompanyFilters {
  /** Free-text query — matched against name and program name. */
  q: string;
  /** Target statuses to include; empty = any. */
  statuses: TargetStatus[];
  /** Derived outreach stages to include; empty = any. */
  traction: OutreachStage[];
  /**
   * Office locations to include; empty = any. Values are `c:<location_id>`,
   * `s:<state>` or `none` — see `company-location-filter.ts`.
   */
  locations: string[];
  /** Contact-presence sides to include; empty (or both) = any. */
  contacts: ContactsFilter[];
  /** Alumni-presence sides to include; empty (or both) = any. */
  alumni: AlumniFilter[];
  /**
   * Only companies where a contact or prospect works there NOW. Distinct from
   * `contacts: ["with"]`, which also keeps a company whose only person has left.
   */
  currentOnly: boolean;
  /** Only companies with an alum of the user's school in a product role. */
  productAlum: boolean;
}

export const EMPTY_COMPANY_FILTERS: CompanyFilters = {
  q: "",
  statuses: [],
  traction: [],
  locations: [],
  contacts: [],
  alumni: [],
  currentOnly: false,
  productAlum: false,
};

const VALID_STATUSES = new Set<string>(TARGET_STATUSES);
const VALID_STAGES = new Set<string>(STAGE_ORDER);
const VALID_CONTACTS = new Set<string>(CONTACTS_FILTERS);
const VALID_ALUMNI = new Set<string>(ALUMNI_FILTERS);

export function hasActiveCompanyFilters(f: CompanyFilters): boolean {
  return (
    f.q.trim() !== "" ||
    f.statuses.length > 0 ||
    f.traction.length > 0 ||
    f.locations.length > 0 ||
    f.contacts.length > 0 ||
    f.alumni.length > 0 ||
    f.currentOnly ||
    f.productAlum
  );
}

/** AND-combine the free-text query with every active facet. */
export function filterCompanies(rows: CompanySummary[], f: CompanyFilters): CompanySummary[] {
  const q = f.q.trim().toLowerCase();
  const statuses = new Set<string>(f.statuses);
  const traction = new Set<string>(f.traction);
  // Parsed once for the whole sweep, not per row: the selection is a fixed
  // input and re-parsing it 2,000 times per keystroke is pure waste.
  const location = parseLocationSelection(f.locations);
  return rows.filter((c) => {
    if (q) {
      const haystacks = [c.name, c.target?.program_name];
      if (!haystacks.some((h) => h != null && h.toLowerCase().includes(q))) return false;
    }
    if (statuses.size > 0 && (!c.target || !statuses.has(c.target.status))) return false;
    if (traction.size > 0 && (c.traction === null || !traction.has(c.traction))) return false;
    if (!matchesLocation(c, location)) return false;
    if (f.contacts.length > 0) {
      const withContacts = c.current_count + c.former_count > 0;
      if (!f.contacts.some((side) => (side === "with" ? withContacts : !withContacts))) return false;
    }
    if (f.alumni.length > 0) {
      const withAlumni = c.alum_count > 0;
      if (!f.alumni.some((side) => (side === "with" ? withAlumni : !withAlumni))) return false;
    }
    // current_count is non-bench contacts (active + prospect) holding a CURRENT role
    // at the company — exactly "someone is there now".
    if (f.currentOnly && c.current_count === 0) return false;
    if (f.productAlum && c.product_alum_count === 0) return false;
    return true;
  });
}

/** Per-status row counts (before status filtering), for chip labels. */
export function countByStatus(rows: CompanySummary[]): Record<TargetStatus, number> {
  const counts = Object.fromEntries(TARGET_STATUSES.map((s) => [s, 0])) as Record<TargetStatus, number>;
  for (const c of rows) {
    const s = c.target?.status;
    if (s && VALID_STATUSES.has(s)) counts[s as TargetStatus]++;
  }
  return counts;
}

/**
 * Counts for the status chips: every active filter applied EXCEPT the status chips
 * themselves (CAR-245).
 *
 * A count printed on a toggle is a promise about what clicking it yields, so it has
 * to move with the rest of the bar — before this, "Researching 314" stayed 314 while
 * a tier facet cut the list to a fraction of that. Clearing `statuses` rather than
 * every facet is what keeps each chip's count answering "how many would I get", and
 * keeps an already-selected chip from shrinking its siblings to zero.
 *
 * The search box counts as a filter here, deliberately: it ANDs like any other
 * facet, so excluding it would leave the counts wrong in the one case the user is
 * looking hardest at them.
 */
export function statusChipCounts(
  rows: CompanySummary[],
  f: CompanyFilters,
): Record<TargetStatus, number> {
  return countByStatus(filterCompanies(rows, { ...f, statuses: [] }));
}

// ── URL param round-trip ────────────────────────────────────────────────
// Scheme: ?q=stripe&status=applied,interviewing&traction=replied,call_done
//          &loc=c:412&loc=s:Utah&contacts=none&alumni=with&current=1&product_alum=1
//
// Param names stay SINGULAR, so every link shared before the facets went
// multi-value still parses: one value lands as a one-element array, and the
// retired `contacts=any` fails validation and falls through to the empty array,
// which is exactly what it meant.
//
// Enum facets are comma-joined (the scheme `status` already used). `loc` is
// REPEATED instead, and never split, for the same reason its `tier` predecessor
// was: a state group is free text and may contain a comma, so splitting would
// turn a link for "Washington, D.C." into two values that match nothing.
// Parsing accepts both forms everywhere; only the emitted shape differs.
//
// `loc` is not validated against the loaded data. A city id for a company the
// current view does not include is simply a value nothing matches, which is the
// honest result for a shared link — silently dropping it would show the
// recipient an unfiltered list that looks like the sender's.

/** Repeated and/or comma-joined param → deduped list of values that pass `valid`. */
function parseList<T extends string>(params: URLSearchParams, key: string, valid: Set<string>): T[] {
  const values = params
    .getAll(key)
    .flatMap((raw) => raw.split(","))
    .map((s) => s.trim())
    .filter((s): s is T => valid.has(s));
  return [...new Set(values)];
}

export function parseCompanyFilters(params: URLSearchParams): CompanyFilters {
  // Location values carry ids and free-text state names, so there is no value
  // list to validate against — only blanks are dropped.
  const locations = params
    .getAll("loc")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    q: params.get("q") ?? "",
    statuses: parseList<TargetStatus>(params, "status", VALID_STATUSES),
    traction: parseList<OutreachStage>(params, "traction", VALID_STAGES),
    locations: [...new Set(locations)],
    contacts: parseList<ContactsFilter>(params, "contacts", VALID_CONTACTS),
    alumni: parseList<AlumniFilter>(params, "alumni", VALID_ALUMNI),
    currentOnly: params.get("current") === "1",
    productAlum: params.get("product_alum") === "1",
  };
}

/**
 * Write the filter state into a copy of `base`, preserving unrelated
 * params (view, sort). Inactive facets are deleted, keeping URLs clean.
 */
export function serializeCompanyFilters(f: CompanyFilters, base: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(base.toString());
  const setOrDelete = (key: string, value: string | null) => {
    if (value) out.set(key, value);
    else out.delete(key);
  };
  const setList = (key: string, values: string[]) =>
    setOrDelete(key, values.length > 0 ? values.join(",") : null);
  /** One param per value, for a facet whose values may contain a comma. */
  const setRepeated = (key: string, values: string[]) => {
    out.delete(key);
    for (const v of values) out.append(key, v);
  };

  setOrDelete("q", f.q.trim() || null);
  setList("status", f.statuses);
  setList("traction", f.traction);
  setRepeated("loc", f.locations);
  setList("contacts", f.contacts);
  setList("alumni", f.alumni);
  setOrDelete("current", f.currentOnly ? "1" : null);
  setOrDelete("product_alum", f.productAlum ? "1" : null);
  return out;
}

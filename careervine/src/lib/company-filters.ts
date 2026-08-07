/**
 * Pure search/filter logic for the Companies page (CAR-32).
 * Kept free of React/Supabase so it can be unit-tested in the node env.
 *
 * FACET CONTRACT (CAR-245). Every multi-value facet holds an array where **empty
 * means any** — the absence of a filter, never "match nothing". Values inside one
 * facet OR together; facets AND with each other. That is what lets a facet's values
 * exhaustively cover its dimension (`contacts` current/former/none, `alumni`
 * with/without) with no special case: selecting every value ORs to everything, the
 * same result as selecting none of them.
 *
 * The corollary, and the reason CAR-248 retired the standalone "works there now"
 * chip: a criterion that belongs to a facet's dimension must be a VALUE in that
 * facet, not a sibling control. Two controls over the same dimension read as
 * overlapping — the user cannot see that one ORs and the other ANDs.
 *
 * Every facet reads a field `getCompanies` already returns, so nothing here implies
 * a query change.
 */

import type { CompanySummary } from "./company-queries";
import { STAGE_ORDER, type OutreachStage } from "./stage-derivation";

export const TARGET_STATUSES = [
  "researching",
  "outreach_active",
  "applied",
  "interviewing",
  "closed",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/**
 * Contact presence, as ONE facet rather than a dropdown plus a chip (CAR-248).
 *
 * `current` = someone works there now; `former` = someone used to; `none` =
 * neither. The first two are not exclusive — a company with one of each matches
 * both — which is what makes their union the old `with`, and all three together
 * the same as selecting nothing.
 *
 * Bench contacts count toward none of them, so a bench-only company reads as
 * `none`. That is `company_network_counts`' split (CAR-229), and it is also what
 * the company card badges, so the filter and the card agree.
 */
export const CONTACTS_FILTERS = ["current", "former", "none"] as const;
export type ContactsFilter = (typeof CONTACTS_FILTERS)[number];

/**
 * `with` = at least one alum of the user's school among CURRENT contacts, which is
 * what `alum_count` counts and what the company card badges. Meaningless without
 * school affinity (`alum_count` is 0 for everyone), so the control is hidden there.
 */
export const ALUMNI_FILTERS = ["with", "without"] as const;
export type AlumniFilter = (typeof ALUMNI_FILTERS)[number];

/**
 * Whether the company is one the user targets (CAR-252).
 *
 * The page loads `scope: "in_play"` — targets UNION companies with a current
 * non-bench contact — so the list genuinely holds both kinds, and `untargeted` is
 * the "who do I know that I haven't targeted yet" view that nothing else reaches.
 * `target` follows `CompanySummary.target`, which `deriveCompanyTarget` leaves null
 * both when no target_companies row exists and when every scope row is
 * soft-untargeted, so "Not a target" agrees with the company card either way.
 *
 * ON THE OVERLAP WITH THE STATUS CHIPS, which the header above makes a live
 * concern: `target_companies.status` is CHECK-pinned to the five TARGET_STATUSES,
 * so selecting every status chip already yields exactly `target`. That is NOT the
 * CAR-248 defect. There the two controls combined DIFFERENTLY (one ANDed, one
 * ORed) with nothing on screen to say which; here both OR within themselves and
 * AND across, so "Target company" + "Applied" behaves as it reads. And the value
 * that motivates the facet, `untargeted`, is unreachable from the chips at all —
 * `target` is its mandatory partner, because a facet only satisfies "select
 * everything = select nothing" when its values cover the dimension.
 */
export const TARGETING_FILTERS = ["target", "untargeted"] as const;
export type TargetingFilter = (typeof TARGETING_FILTERS)[number];

export interface CompanyFilters {
  /** Free-text query — matched against name, program name, and tier label. */
  q: string;
  /** Target statuses to include; empty = any. */
  statuses: TargetStatus[];
  /** Derived outreach stages to include; empty = any. */
  traction: OutreachStage[];
  /** Tier labels to include; empty = any. */
  tiers: string[];
  /** Contact-presence values to include; empty (or all three) = any. */
  contacts: ContactsFilter[];
  /** Alumni-presence sides to include; empty (or both) = any. */
  alumni: AlumniFilter[];
  /** Target-vs-not sides to include; empty (or both) = any. */
  targeting: TargetingFilter[];
  /** Only companies with an alum of the user's school in a product role. */
  productAlum: boolean;
}

export const EMPTY_COMPANY_FILTERS: CompanyFilters = {
  q: "",
  statuses: [],
  traction: [],
  tiers: [],
  contacts: [],
  alumni: [],
  targeting: [],
  productAlum: false,
};

const VALID_STATUSES = new Set<string>(TARGET_STATUSES);
const VALID_STAGES = new Set<string>(STAGE_ORDER);
const VALID_CONTACTS = new Set<string>(CONTACTS_FILTERS);
const VALID_ALUMNI = new Set<string>(ALUMNI_FILTERS);
const VALID_TARGETING = new Set<string>(TARGETING_FILTERS);

export function hasActiveCompanyFilters(f: CompanyFilters): boolean {
  return (
    f.q.trim() !== "" ||
    f.statuses.length > 0 ||
    f.traction.length > 0 ||
    f.tiers.length > 0 ||
    f.contacts.length > 0 ||
    f.alumni.length > 0 ||
    f.targeting.length > 0 ||
    f.productAlum
  );
}

/** Does a company satisfy one contact-presence value? */
function matchesContacts(c: CompanySummary, side: ContactsFilter): boolean {
  // current_count is non-bench contacts (active + prospect) holding a CURRENT
  // role at the company — exactly "someone is there now". former_count is the
  // same people minus a current role, so the two never double-count a contact.
  if (side === "current") return c.current_count > 0;
  if (side === "former") return c.former_count > 0;
  return c.current_count + c.former_count === 0;
}

/** AND-combine the free-text query with every active facet. */
export function filterCompanies(rows: CompanySummary[], f: CompanyFilters): CompanySummary[] {
  const q = f.q.trim().toLowerCase();
  const statuses = new Set<string>(f.statuses);
  const traction = new Set<string>(f.traction);
  const tiers = new Set<string>(f.tiers);
  return rows.filter((c) => {
    if (q) {
      const haystacks = [c.name, c.target?.program_name, c.target?.tier];
      if (!haystacks.some((h) => h != null && h.toLowerCase().includes(q))) return false;
    }
    if (statuses.size > 0 && (!c.target || !statuses.has(c.target.status))) return false;
    if (traction.size > 0 && (c.traction === null || !traction.has(c.traction))) return false;
    if (tiers.size > 0 && (c.target?.tier == null || !tiers.has(c.target.tier))) return false;
    if (f.contacts.length > 0 && !f.contacts.some((side) => matchesContacts(c, side))) return false;
    if (f.alumni.length > 0) {
      const withAlumni = c.alum_count > 0;
      if (!f.alumni.some((side) => (side === "with" ? withAlumni : !withAlumni))) return false;
    }
    if (f.targeting.length > 0) {
      const isTarget = c.target != null;
      if (!f.targeting.some((side) => (side === "target" ? isTarget : !isTarget))) return false;
    }
    if (f.productAlum && c.product_alum_count === 0) return false;
    return true;
  });
}

/** Distinct tier labels present in the data, for the tier dropdown. */
export function distinctTiers(rows: CompanySummary[]): string[] {
  const tiers = new Set<string>();
  for (const c of rows) {
    const t = c.target?.tier?.trim();
    if (t) tiers.add(t);
  }
  return [...tiers].sort((a, b) => a.localeCompare(b));
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
//          &tier=Big+Tech&tier=Utah&contacts=none&alumni=with&targeting=untargeted
//          &product_alum=1
//
// Param names stay SINGULAR, so every link shared before the facets went
// multi-value still parses: one value lands as a one-element array, and the
// retired `contacts=any` fails validation and falls through to the empty array,
// which is exactly what it meant.
//
// Two more retired spellings are MIGRATED rather than dropped, because unlike
// `any` they carried a real filter (CAR-248) — see `migrateLegacyContacts`.
//
// Enum facets are comma-joined (the scheme `status` already used). `tier` is
// REPEATED instead, and never split: a tier label is free text and may itself
// contain a comma, so splitting would turn the pre-existing link for a tier named
// "Foo, Bar" into two tiers that match nothing. Parsing accepts both forms
// everywhere; only the emitted shape differs.

/** Repeated and/or comma-joined param → deduped list of values that pass `valid`. */
function parseList<T extends string>(params: URLSearchParams, key: string, valid: Set<string>): T[] {
  const values = params
    .getAll(key)
    .flatMap((raw) => raw.split(","))
    .map((s) => s.trim())
    .filter((s): s is T => valid.has(s));
  return [...new Set(values)];
}

/**
 * Fold the pre-CAR-248 contact params into the three-value facet, so a link
 * shared while the row had a dropdown AND a "works there now" chip still
 * filters the way its author meant.
 *
 * - `contacts=with` was "current or former", which is now both values.
 * - `current=1` was a separate AND-ing toggle, so it NARROWS what the dropdown
 *   parsed to. A legacy link can only be in two states — `current=1` alone, or
 *   `current=1&contacts=with` — and both map exactly onto `["current"]`.
 * - `current=1&contacts=none` was self-contradictory and rendered an empty list.
 *   It has no equivalent here, and resolving it toward `none` is the choice that
 *   shows the user something rather than nothing.
 */
function migrateLegacyContacts(params: URLSearchParams, parsed: ContactsFilter[]): ContactsFilter[] {
  const raw = params.getAll("contacts").flatMap((s) => s.split(",")).map((s) => s.trim());
  const contacts = raw.includes("with")
    ? CONTACTS_FILTERS.filter((v) => v !== "none" || parsed.includes("none"))
    : parsed;
  if (params.get("current") !== "1") return contacts;
  return contacts.length === 0 || contacts.includes("current") ? ["current"] : contacts;
}

export function parseCompanyFilters(params: URLSearchParams): CompanyFilters {
  // Tiers are free text (a user-defined label), so there is no value list to
  // validate against — only blanks are dropped.
  const tiers = params
    .getAll("tier")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    q: params.get("q") ?? "",
    statuses: parseList<TargetStatus>(params, "status", VALID_STATUSES),
    traction: parseList<OutreachStage>(params, "traction", VALID_STAGES),
    tiers: [...new Set(tiers)],
    contacts: migrateLegacyContacts(
      params,
      parseList<ContactsFilter>(params, "contacts", VALID_CONTACTS),
    ),
    alumni: parseList<AlumniFilter>(params, "alumni", VALID_ALUMNI),
    // New in CAR-252, so there is no legacy spelling to fold in: every link shared
    // before it carries no `targeting` param and parses to [], which is exactly the
    // absence of the filter.
    targeting: parseList<TargetingFilter>(params, "targeting", VALID_TARGETING),
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
  setRepeated("tier", f.tiers);
  setList("contacts", f.contacts);
  setList("alumni", f.alumni);
  setList("targeting", f.targeting);
  // Retired in CAR-248. Deleted rather than merely not written: `parse` has
  // already folded it into `contacts`, so leaving it on the URL would apply it a
  // second time on the next read and re-narrow a filter the user just widened.
  out.delete("current");
  setOrDelete("product_alum", f.productAlum ? "1" : null);
  return out;
}

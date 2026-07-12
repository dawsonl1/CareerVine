/**
 * Pure search/filter logic for the Companies page (CAR-32).
 * Kept free of React/Supabase so it can be unit-tested in the node env.
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

export type ContactsFilter = "any" | "with" | "none";

export interface CompanyFilters {
  /** Free-text query — matched against name, program name, and tier label. */
  q: string;
  /** Target statuses to include; empty = any. */
  statuses: TargetStatus[];
  traction: OutreachStage | null;
  tier: string | null;
  contacts: ContactsFilter;
  /** Only companies with a BYU alum in a product role. */
  productAlum: boolean;
}

export const EMPTY_COMPANY_FILTERS: CompanyFilters = {
  q: "",
  statuses: [],
  traction: null,
  tier: null,
  contacts: "any",
  productAlum: false,
};

const VALID_STATUSES = new Set<string>(TARGET_STATUSES);
const VALID_STAGES = new Set<string>(STAGE_ORDER);

export function hasActiveCompanyFilters(f: CompanyFilters): boolean {
  return (
    f.q.trim() !== "" ||
    f.statuses.length > 0 ||
    f.traction !== null ||
    f.tier !== null ||
    f.contacts !== "any" ||
    f.productAlum
  );
}

/** AND-combine the free-text query with every active facet. */
export function filterCompanies(rows: CompanySummary[], f: CompanyFilters): CompanySummary[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((c) => {
    if (q) {
      const haystacks = [c.name, c.target?.program_name, c.target?.tier];
      if (!haystacks.some((h) => h != null && h.toLowerCase().includes(q))) return false;
    }
    if (f.statuses.length > 0 && (!c.target || !f.statuses.includes(c.target.status as TargetStatus))) {
      return false;
    }
    if (f.traction !== null && c.traction !== f.traction) return false;
    if (f.tier !== null && c.target?.tier !== f.tier) return false;
    if (f.contacts !== "any") {
      const withContacts = c.current_count + c.former_count > 0;
      if (f.contacts === "with" ? !withContacts : withContacts) return false;
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

// ── URL param round-trip ────────────────────────────────────────────────
// Scheme: ?q=stripe&status=applied,interviewing&traction=replied&tier=Big+Tech&contacts=none

export function parseCompanyFilters(params: URLSearchParams): CompanyFilters {
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is TargetStatus => VALID_STATUSES.has(s));
  const rawTraction = params.get("traction");
  const rawTier = params.get("tier")?.trim();
  const rawContacts = params.get("contacts");
  return {
    q: params.get("q") ?? "",
    statuses: [...new Set(statuses)],
    traction: rawTraction && VALID_STAGES.has(rawTraction) ? (rawTraction as OutreachStage) : null,
    tier: rawTier || null,
    contacts: rawContacts === "with" || rawContacts === "none" ? rawContacts : "any",
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
  setOrDelete("q", f.q.trim() || null);
  setOrDelete("status", f.statuses.length > 0 ? f.statuses.join(",") : null);
  setOrDelete("traction", f.traction);
  setOrDelete("tier", f.tier);
  setOrDelete("contacts", f.contacts === "any" ? null : f.contacts);
  setOrDelete("product_alum", f.productAlum ? "1" : null);
  return out;
}

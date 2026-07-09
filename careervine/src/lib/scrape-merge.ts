/**
 * Merge engine for scraped re-imports (plan 24, replaces the extension
 * route's delete-and-reinsert pattern which would wipe manual edits).
 *
 * Pure functions: they compute merge plans from existing + incoming rows;
 * the bulk-import route applies the plans. Core invariants:
 *
 *  - Scraped data NEVER overwrites manual data. Manual employment rows
 *    survive re-imports untouched (except scraped_at confirmation);
 *    manually-set locations win; manual emails are never modified.
 *  - Rows are matched on the natural key (company, title, start_month) —
 *    boomerang stints (two Google rows, different start_month) and
 *    concurrent roles (multiple is_current) stay distinct.
 *  - Deletes apply only to scraped-sourced rows absent from the new
 *    payload.
 *  - Email source lifecycle is monotonic: verified > scraped >
 *    pattern_guessed. Re-imports may upgrade, never downgrade.
 *  - Persona is never overwritten with a different non-null value —
 *    conflicts are reported, not applied.
 *
 * Merge policies (plan 29): 'pipeline' is the original behavior for
 * Dawson's scrape-pipeline re-imports, where the pipeline owns scraped
 * data wholesale (refreshes headline/provenance, deletes scraped rows
 * absent from the payload). 'bundle' is for shared data-bundle syncs into
 * OTHER users' accounts: strict fill-empty on contact fields, provenance
 * stamped on create only, and never deletes employment rows it didn't
 * supply — two overlapping bundles (or a bundle plus the pipeline) must
 * not thrash each other's data, and a silent background sync must never
 * overwrite anything a user typed.
 */

import type { MappedPerson } from "./scrape-mapper";

export type MergePolicy = "pipeline" | "bundle";

// ── Employment ─────────────────────────────────────────────────────────

export interface ExistingEmploymentRow {
  id: number;
  company_id: number;
  title: string | null;
  start_month: string | null;
  end_month: string | null;
  is_current: boolean;
  location_id: number | null;
  location_source: string | null;
  location_raw: string | null;
  workplace_type: string | null;
  employment_type: string | null;
  source: string;
}

export interface IncomingEmploymentRow {
  company_id: number;
  title: string | null;
  start_month: string | null;
  end_month: string | null;
  is_current: boolean;
  location_id: number | null;
  location_source: string | null;
  location_raw: string | null;
  workplace_type: string | null;
  employment_type: string | null;
}

export interface EmploymentMergePlan {
  inserts: Array<IncomingEmploymentRow & { source: "scraped"; scraped_at: string }>;
  updates: Array<{ id: number; fields: Record<string, unknown> }>;
  deleteIds: number[];
}

/** Natural key: same company + title + start month = the same stint. */
export function employmentKey(e: {
  company_id: number;
  title: string | null;
  start_month: string | null;
}): string {
  return `${e.company_id}|${(e.title ?? "").trim().toLowerCase()}|${(e.start_month ?? "").trim().toLowerCase()}`;
}

export function computeEmploymentMerge(
  existing: ExistingEmploymentRow[],
  incoming: IncomingEmploymentRow[],
  scrapedAt: string,
  policy: MergePolicy = "pipeline",
): EmploymentMergePlan {
  // Dedupe incoming on the natural key (defensive against actor glitches)
  const incomingByKey = new Map<string, IncomingEmploymentRow>();
  for (const row of incoming) {
    const key = employmentKey(row);
    if (!incomingByKey.has(key)) incomingByKey.set(key, row);
  }

  const plan: EmploymentMergePlan = { inserts: [], updates: [], deleteIds: [] };
  const matchedKeys = new Set<string>();

  for (const row of existing) {
    const key = employmentKey(row);
    const match = incomingByKey.get(key);
    if (!match || matchedKeys.has(key)) {
      // Absent from the new payload: delete only scraped rows, and only
      // under the pipeline policy — a bundle owns just the rows it sends
      if (!match && row.source === "scraped" && policy === "pipeline") plan.deleteIds.push(row.id);
      continue;
    }
    matchedKeys.add(key);

    if (row.source === "manual") {
      // The scrape confirms a manual row exists — record freshness only
      plan.updates.push({ id: row.id, fields: { scraped_at: scrapedAt } });
      continue;
    }

    const fields: Record<string, unknown> = { scraped_at: scrapedAt };
    if (row.end_month !== match.end_month) fields.end_month = match.end_month;
    if (row.is_current !== match.is_current) fields.is_current = match.is_current;
    if (row.workplace_type !== match.workplace_type) fields.workplace_type = match.workplace_type;
    if (row.employment_type !== match.employment_type) fields.employment_type = match.employment_type;
    // Manually-set locations win; everything else follows the fresh scrape
    if (row.location_source !== "manual") {
      if (row.location_id !== match.location_id) fields.location_id = match.location_id;
      if (row.location_source !== match.location_source) fields.location_source = match.location_source;
      if (row.location_raw !== match.location_raw) fields.location_raw = match.location_raw;
    }
    plan.updates.push({ id: row.id, fields });
  }

  for (const [key, row] of incomingByKey) {
    if (!matchedKeys.has(key)) {
      plan.inserts.push({ ...row, source: "scraped", scraped_at: scrapedAt });
    }
  }

  return plan;
}

// ── Emails ─────────────────────────────────────────────────────────────

export interface ExistingEmailRow {
  id: number;
  email: string | null;
  is_primary: boolean;
  source: string;
}

export interface EmailMergePlan {
  insert: { email: string; source: string; is_primary: boolean } | null;
  update: { id: number; fields: { source: string } } | null;
}

const EMAIL_SOURCE_RANK: Record<string, number> = {
  pattern_guessed: 1,
  scraped: 2,
  verified: 3,
};

export function computeEmailMerge(
  existing: ExistingEmailRow[],
  incoming: { address: string; source: string } | null,
): EmailMergePlan {
  if (!incoming) return { insert: null, update: null };
  const address = incoming.address.trim().toLowerCase();
  if (!address) return { insert: null, update: null };

  const match = existing.find((e) => (e.email ?? "").trim().toLowerCase() === address);
  if (match) {
    // Manual rows are never modified by imports; scraped-lineage rows may
    // only move up the trust ladder.
    if (
      match.source !== "manual" &&
      (EMAIL_SOURCE_RANK[incoming.source] ?? 0) > (EMAIL_SOURCE_RANK[match.source] ?? 0)
    ) {
      return { insert: null, update: { id: match.id, fields: { source: incoming.source } } };
    }
    return { insert: null, update: null };
  }

  const hasPrimary = existing.some((e) => e.is_primary);
  return {
    insert: { email: address, source: incoming.source, is_primary: !hasPrimary },
    update: null,
  };
}

// ── Contact core ───────────────────────────────────────────────────────

export interface ExistingContactCore {
  id: number;
  name: string;
  persona: string | null;
  network_status: string;
  location_id: number | null;
  headline: string | null;
  public_identifier?: string | null;
}

export interface ContactPatchResult {
  patch: Record<string, unknown>;
  personaConflict: { existing: string; incoming: string } | null;
}

/**
 * Resolve the network tier for a re-import: an import never demotes.
 * active stays active; prospect stays prospect even if the pipeline now
 * benches the person; bench may be promoted to prospect.
 */
export function resolveNetworkStatus(
  existing: string,
  incoming: "prospect" | "bench",
): string {
  if (existing === "active") return "active";
  if (existing === "prospect") return "prospect";
  return incoming; // existing === 'bench' (or unknown): follow the pipeline
}

export function computeContactPatch(
  existing: ExistingContactCore,
  mapped: MappedPerson,
  nowIso: string,
  profileLocationId: number | null,
  policy: MergePolicy = "pipeline",
): ContactPatchResult {
  const patch: Record<string, unknown> = { last_scraped_at: nowIso };

  if (policy === "pipeline") {
    // The pipeline owns scraped fields + provenance wholesale
    patch.review_note = mapped.review_note;
    patch.import_source = mapped.import_source;
    patch.import_meta = mapped.import_meta;
    // Pipeline-owned segment label — refreshed every import (a person can
    // move onto a target company between tranches)
    patch.network_scope = mapped.network_scope;
    if (mapped.headline) patch.headline = mapped.headline;
    if (mapped.public_identifier) patch.public_identifier = mapped.public_identifier;
  } else {
    // Bundle policy: strict fill-empty — a background sync must never
    // overwrite a user edit or another source's provenance
    if (mapped.headline && !existing.headline) patch.headline = mapped.headline;
    if (mapped.public_identifier && !existing.public_identifier) {
      patch.public_identifier = mapped.public_identifier;
    }
  }

  if (mapped.verified_school) patch.verified_school = mapped.verified_school;

  // Names: manual edits win. Refresh only placeholder names.
  if ((!existing.name || existing.name === "Unknown") && mapped.name) {
    patch.name = mapped.name;
  }

  // Profile location: set only when the contact has none (manual wins)
  if (existing.location_id == null && profileLocationId != null) {
    patch.location_id = profileLocationId;
  }

  const resolvedStatus = resolveNetworkStatus(existing.network_status, mapped.network_status);
  if (resolvedStatus !== existing.network_status) patch.network_status = resolvedStatus;

  let personaConflict: ContactPatchResult["personaConflict"] = null;
  if (mapped.persona) {
    if (!existing.persona) {
      patch.persona = mapped.persona;
    } else if (existing.persona !== mapped.persona) {
      personaConflict = { existing: existing.persona, incoming: mapped.persona };
    }
  }

  return { patch, personaConflict };
}

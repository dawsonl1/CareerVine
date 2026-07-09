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
 */

import type { MappedPerson } from "./scrape-mapper";

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

/**
 * How to handle an unmatched CURRENT incoming role at a company that already
 * has an unmatched CURRENT existing role (plan 29 M2):
 *  - "insert" (default, pipeline bulk-import): keep strict natural-key matching;
 *    the incoming row becomes a new sibling row.
 *  - "skip" (rescrape/enrich, interim): leave the existing current role in place
 *    (just confirm scraped_at) and drop the incoming duplicate. Never clobbers a
 *    user-typed role and never creates a confusing duplicate; worst case a title
 *    is briefly stale. Safe while extension AI-parsed rows are indistinguishable
 *    from hand-typed ones (both source='manual').
 *  - "supersede": overwrite the existing current role in place with the scrape's
 *    values. Only safe once AI-parsed rows carry a distinct provenance, or the
 *    data loss the deep review flagged is reintroduced — NOT used yet.
 */
export type CurrentCollisionStrategy = "insert" | "skip" | "supersede";

export interface EmploymentMergeOptions {
  currentCollisionStrategy?: CurrentCollisionStrategy;
}

/** Build the field patch for an existing row matched to an incoming row by natural key. */
function buildMatchUpdate(
  row: ExistingEmploymentRow,
  match: IncomingEmploymentRow,
  scrapedAt: string,
): { id: number; fields: Record<string, unknown> } {
  if (row.source === "manual") {
    // The scrape confirms a manual row exists — record freshness only
    return { id: row.id, fields: { scraped_at: scrapedAt } };
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
  return { id: row.id, fields };
}

export function computeEmploymentMerge(
  existing: ExistingEmploymentRow[],
  incoming: IncomingEmploymentRow[],
  scrapedAt: string,
  opts: EmploymentMergeOptions = {},
): EmploymentMergePlan {
  // Dedupe incoming on the natural key (defensive against actor glitches)
  const incomingByKey = new Map<string, IncomingEmploymentRow>();
  for (const row of incoming) {
    const key = employmentKey(row);
    if (!incomingByKey.has(key)) incomingByKey.set(key, row);
  }

  const plan: EmploymentMergePlan = { inserts: [], updates: [], deleteIds: [] };
  const matchedKeys = new Set<string>();
  const consumedExistingIds = new Set<number>();

  // Pass A: exact natural-key matches (same company + title + start month).
  for (const row of existing) {
    const key = employmentKey(row);
    const match = incomingByKey.get(key);
    if (!match || matchedKeys.has(key)) continue;
    matchedKeys.add(key);
    consumedExistingIds.add(row.id);
    plan.updates.push(buildMatchUpdate(row, match, scrapedAt));
  }

  // Pass B: reconcile an unmatched CURRENT existing row with an unmatched
  // CURRENT incoming row at the same company (same job, different natural key).
  const strategy: CurrentCollisionStrategy = opts.currentCollisionStrategy ?? "insert";
  if (strategy !== "insert") {
    for (const row of existing) {
      if (consumedExistingIds.has(row.id) || !row.is_current) continue;
      let matchKey: string | undefined;
      for (const [key, inc] of incomingByKey) {
        if (matchedKeys.has(key)) continue;
        if (inc.is_current && inc.company_id === row.company_id) {
          matchKey = key;
          break;
        }
      }
      if (!matchKey) continue;
      const inc = incomingByKey.get(matchKey)!;
      matchedKeys.add(matchKey);
      consumedExistingIds.add(row.id);

      if (strategy === "skip") {
        // Leave the existing role untouched; just confirm we saw it. No clobber,
        // no duplicate.
        plan.updates.push({ id: row.id, fields: { scraped_at: scrapedAt } });
        continue;
      }

      // strategy === "supersede": overwrite in place with the scrape's values.
      const fields: Record<string, unknown> = {
        title: inc.title,
        start_month: inc.start_month,
        end_month: inc.end_month,
        is_current: inc.is_current,
        workplace_type: inc.workplace_type,
        employment_type: inc.employment_type,
        source: "scraped",
        scraped_at: scrapedAt,
      };
      // A deliberately user-set location still wins; an AI-parsed one is replaced.
      if (row.location_source !== "manual") {
        fields.location_id = inc.location_id;
        fields.location_source = inc.location_source;
        fields.location_raw = inc.location_raw;
      }
      plan.updates.push({ id: row.id, fields });
    }
  }

  // Pass C: existing scraped rows entirely absent from the payload are deleted.
  // (Rows whose key exists in the payload but was consumed by another existing
  // row — duplicates — are left untouched, matching the original behavior.)
  for (const row of existing) {
    if (consumedExistingIds.has(row.id)) continue;
    const key = employmentKey(row);
    if (!incomingByKey.has(key) && row.source === "scraped") plan.deleteIds.push(row.id);
  }

  // Pass D: unmatched incoming rows are fresh inserts.
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

/**
 * "import" = pipeline bulk import (full provenance write).
 * "rescrape" = in-app re-scrape / enrich of a contact that already exists
 *   (plan 29). A rescrape refreshes only *observed profile data* and must
 *   NEVER touch pipeline- or user-owned fields: network_status, network_scope,
 *   import_source, import_meta, review_note, persona, verified_school. Skipping
 *   them prevents a synthetic re-scrape record — which carries no pipeline
 *   block — from mass-promoting bench→prospect, stamping everyone
 *   target_company, or wiping priority_rank / review verdicts on the whole
 *   fleet (audit blocker B1).
 */
export type ContactPatchMode = "import" | "rescrape";

export function computeContactPatch(
  existing: ExistingContactCore,
  mapped: MappedPerson,
  nowIso: string,
  profileLocationId: number | null,
  mode: ContactPatchMode = "import",
): ContactPatchResult {
  if (mode === "rescrape") {
    const patch: Record<string, unknown> = { last_scraped_at: nowIso };
    if (mapped.headline) patch.headline = mapped.headline;
    if (mapped.public_identifier) patch.public_identifier = mapped.public_identifier;
    // Names: manual edits win; refresh only placeholder names.
    if ((!existing.name || existing.name === "Unknown") && mapped.name) {
      patch.name = mapped.name;
    }
    // Profile location: set only when the contact has none (manual wins).
    if (existing.location_id == null && profileLocationId != null) {
      patch.location_id = profileLocationId;
    }
    return { patch, personaConflict: null };
  }

  const patch: Record<string, unknown> = {
    review_note: mapped.review_note,
    import_source: mapped.import_source,
    import_meta: mapped.import_meta,
    // Pipeline-owned segment label — refreshed every import (a person can
    // move onto a target company between tranches)
    network_scope: mapped.network_scope,
    last_scraped_at: nowIso,
  };

  if (mapped.headline) patch.headline = mapped.headline;
  if (mapped.verified_school) patch.verified_school = mapped.verified_school;
  if (mapped.public_identifier) patch.public_identifier = mapped.public_identifier;

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

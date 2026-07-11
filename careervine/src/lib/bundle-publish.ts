/**
 * Bundle publish flow (plan 29 §4). Runs ONLY on the service-role client —
 * bundle content tables have no user write policies by design.
 *
 * A publish is a staged run under a lock:
 *   beginPublish        claims data_bundles.staging_version (= version + 1)
 *   publishProspectsChunk / publishCompaniesChunk   stage content (≤50/call)
 *   finalizePublish     soft-removes unseen prospects, prunes unseen company
 *                       memberships, recomputes counts, commits the version
 *                       bump (or skips it when nothing changed), clears the lock
 *   abortPublish        clears the lock without committing
 *
 * Correctness invariants:
 *  - Subscriber sync only ever applies rows with version_updated <= the
 *    COMMITTED data_bundles.version pinned at sync start, so staged rows
 *    from an in-flight (or crashed) publish are never applied.
 *  - Re-running a publish with identical payloads causes zero version
 *    churn: hashes match, only version_last_seen moves.
 *  - Two concurrent publishes are impossible: the lock is claimed with a
 *    conditional UPDATE and rejected while held and unexpired.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BUNDLE_PAYLOAD_SCHEMA_VERSION,
  bundleProspectPayloadV1Schema,
  type BundleCompanyEntry,
  type BundleProspectPayloadV1,
} from "./bundle-payload";
import { findOrCreateCompany, findOrCreateLocation, ensureCompanyLocation } from "./company-helpers";

/** A crashed publish's lock may be reclaimed after this window. */
export const PUBLISH_LOCK_EXPIRY_MS = 15 * 60 * 1000;

export class BundlePublishError extends Error {
  constructor(
    message: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = "BundlePublishError";
  }
}

// ── Hashing ────────────────────────────────────────────────────────────

/** JSON.stringify with recursively sorted keys — hash stability must not
 * depend on property insertion order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashPayload(payload: BundleProspectPayloadV1): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// ── Begin / abort ──────────────────────────────────────────────────────

export interface BeginPublishResult {
  bundleId: number;
  stagingVersion: number;
}

export async function beginPublish(
  service: SupabaseClient,
  input: { slug: string; name?: string; description?: string | null },
): Promise<BeginPublishResult> {
  const nowIso = new Date().toISOString();

  let { data: bundle } = await service
    .from("data_bundles")
    .select("id, version, staging_version, staging_claimed_at")
    .eq("slug", input.slug)
    .maybeSingle();

  if (!bundle) {
    if (!input.name) throw new BundlePublishError(`Bundle "${input.slug}" does not exist and no name was given to create it`);
    const { data: created, error } = await service
      .from("data_bundles")
      .insert({ slug: input.slug, name: input.name, description: input.description ?? null })
      .select("id, version, staging_version, staging_claimed_at")
      .single();
    if (error || !created) throw new BundlePublishError(`Failed to create bundle: ${error?.message}`);
    bundle = created;
  }

  const row = bundle as { id: number; version: number; staging_version: number | null; staging_claimed_at: string | null };
  const stagingVersion = row.version + 1;
  const staleCutoff = new Date(Date.now() - PUBLISH_LOCK_EXPIRY_MS).toISOString();

  // Claim the publish lock: free, or held by an expired (crashed) run.
  const claim: Record<string, unknown> = {
    staging_version: stagingVersion,
    staging_claimed_at: nowIso,
    updated_at: nowIso,
  };
  if (input.name) claim.name = input.name;
  if (input.description !== undefined) claim.description = input.description;

  // CAS success is detected via the updated-row COUNT, never the returned
  // representation: PostgREST re-applies the request filters to the RETURNING
  // rows, and this update changes the very column the filter tests
  // (staging_version is no longer null after claiming), so a successful claim
  // returns an empty representation. Found live on first prod publish.
  const { count } = await service
    .from("data_bundles")
    .update(claim, { count: "exact" })
    .eq("id", row.id)
    .or(`staging_version.is.null,staging_claimed_at.lt.${staleCutoff}`);

  if ((count ?? 0) !== 1) {
    throw new BundlePublishError(
      `Bundle "${input.slug}" already has a publish in progress (staging v${row.staging_version}). Finish, abort, or wait for the lock to expire.`,
      409,
    );
  }

  return { bundleId: row.id, stagingVersion };
}

export async function abortPublish(
  service: SupabaseClient,
  slug: string,
  stagingVersion: number,
): Promise<void> {
  await service
    .from("data_bundles")
    .update({ staging_version: null, staging_claimed_at: null, updated_at: new Date().toISOString() })
    .eq("slug", slug)
    .eq("staging_version", stagingVersion);
}

// ── Prospect staging ───────────────────────────────────────────────────

export interface ProspectChunkResult {
  added: number;
  updated: number;
  unchanged: number;
  readded: number;
}

async function requireLockedBundle(service: SupabaseClient, slug: string, stagingVersion: number) {
  const { data } = await service
    .from("data_bundles")
    .select("id, version, staging_version")
    .eq("slug", slug)
    .maybeSingle();
  const bundle = data as { id: number; version: number; staging_version: number | null } | null;
  if (!bundle) throw new BundlePublishError(`Bundle "${slug}" not found`, 404);
  if (bundle.staging_version !== stagingVersion) {
    throw new BundlePublishError(
      `Bundle "${slug}" is not staging v${stagingVersion} (current staging: ${bundle.staging_version ?? "none"}) — call begin first`,
      409,
    );
  }
  return bundle;
}

export async function publishProspectsChunk(
  service: SupabaseClient,
  slug: string,
  stagingVersion: number,
  prospects: unknown[],
): Promise<ProspectChunkResult> {
  if (prospects.length > 50) throw new BundlePublishError("Max 50 prospects per chunk");
  const bundle = await requireLockedBundle(service, slug, stagingVersion);
  const nowIso = new Date().toISOString();

  // Validate the whole chunk before writing anything — a malformed record
  // rejects the chunk so the driver can fix its input.
  const validated: Array<{ payload: BundleProspectPayloadV1; hash: string }> = [];
  for (let i = 0; i < prospects.length; i++) {
    const parsed = bundleProspectPayloadV1Schema.safeParse(prospects[i]);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BundlePublishError(
        `Prospect ${i} invalid: ${issue?.path?.join(".") ?? ""} ${issue?.message ?? "unknown"}`,
      );
    }
    validated.push({ payload: parsed.data, hash: hashPayload(parsed.data) });
  }

  // Last occurrence wins on duplicate URLs within a chunk.
  const byUrl = new Map(validated.map((v) => [v.payload.linkedin_url, v]));

  const { data: existingRows } = await service
    .from("bundle_prospects")
    .select("id, linkedin_url, payload_hash")
    .eq("bundle_id", bundle.id)
    .in("linkedin_url", [...byUrl.keys()]);
  const existingByUrl = new Map(
    ((existingRows as Array<{ id: number; linkedin_url: string; payload_hash: string }> | null) ?? []).map((r) => [
      r.linkedin_url,
      r,
    ]),
  );

  const result: ProspectChunkResult = { added: 0, updated: 0, unchanged: 0, readded: 0 };
  const inserts: Record<string, unknown>[] = [];

  for (const { payload, hash } of byUrl.values()) {
    const existing = existingByUrl.get(payload.linkedin_url);
    if (!existing) {
      inserts.push({
        bundle_id: bundle.id,
        linkedin_url: payload.linkedin_url,
        payload,
        payload_schema_version: BUNDLE_PAYLOAD_SCHEMA_VERSION,
        payload_hash: hash,
        version_added: stagingVersion,
        version_updated: stagingVersion,
        version_last_seen: stagingVersion,
      });
      result.added++;
      continue;
    }

    if (existing.payload_hash === hash) {
      // Unchanged: only mark as seen (and revive if it was soft-removed).
      // We can't cheaply tell removed rows apart here; counting revivals
      // needs the flag, so select it lazily only when someone cares — the
      // update itself is identical either way.
      const { data: touched } = await service
        .from("bundle_prospects")
        .update({ version_last_seen: stagingVersion, removed_in_version: null, updated_at: nowIso })
        .eq("id", existing.id)
        .select("version_added")
        .single();
      if (touched && (touched as { version_added: number }).version_added < stagingVersion) result.unchanged++;
      else result.readded++;
      continue;
    }

    await service
      .from("bundle_prospects")
      .update({
        payload,
        payload_schema_version: BUNDLE_PAYLOAD_SCHEMA_VERSION,
        payload_hash: hash,
        version_updated: stagingVersion,
        version_last_seen: stagingVersion,
        removed_in_version: null,
        // The old resolution snapshot is keyed to the previous payload hash —
        // drop it so this row reads as unresolved (CAR-81). This is what makes
        // `resolved IS NULL` an exact "needs resolution" predicate for the
        // resolver's DB filter; without it a changed row keeps a stale snapshot
        // that the null-filter would skip forever.
        resolved: null,
        updated_at: nowIso,
      })
      .eq("id", existing.id);
    result.updated++;
  }

  if (inserts.length > 0) {
    const { error } = await service.from("bundle_prospects").insert(inserts);
    if (error) throw new BundlePublishError(`Prospect insert failed: ${error.message}`, 500);
  }

  return result;
}

// ── Company staging ────────────────────────────────────────────────────

export interface CompanyChunkResult {
  companies: number;
  offices: number;
}

export async function publishCompaniesChunk(
  service: SupabaseClient,
  slug: string,
  stagingVersion: number,
  companies: BundleCompanyEntry[],
): Promise<CompanyChunkResult> {
  if (companies.length > 50) throw new BundlePublishError("Max 50 companies per chunk");
  const bundle = await requireLockedBundle(service, slug, stagingVersion);

  const result: CompanyChunkResult = { companies: 0, offices: 0 };
  for (const entry of companies) {
    const company = await findOrCreateCompany(service, {
      name: entry.name,
      linkedin_company_id: entry.linkedin_company_id ?? null,
      linkedin_url: entry.linkedin_url ?? null,
      universal_name: entry.universal_name ?? null,
    });

    // Merge (not ignoreDuplicates): existing memberships must get their
    // version_last_seen stamped, or finalize would prune them as unseen.
    const { error } = await service
      .from("bundle_companies")
      .upsert(
        { bundle_id: bundle.id, company_id: company.id, version_last_seen: stagingVersion },
        { onConflict: "bundle_id,company_id" },
      );
    if (error) throw new BundlePublishError(`bundle_companies upsert failed: ${error.message}`, 500);
    result.companies++;

    for (const office of entry.offices) {
      if (!office.city && !office.state) continue;
      const location = await findOrCreateLocation(service, {
        city: office.city,
        state: office.state,
        country: office.country ?? "United States",
      });
      await ensureCompanyLocation(service, company.id, location.id, "manual");
      result.offices++;
    }
  }

  return result;
}

// ── Finalize ───────────────────────────────────────────────────────────

export interface FinalizePublishResult {
  published: boolean;
  version: number;
  prospectCount: number;
  companyCount: number;
  removed: number;
  companiesPruned: number;
}

export async function finalizePublish(
  service: SupabaseClient,
  slug: string,
  stagingVersion: number,
): Promise<FinalizePublishResult> {
  const bundle = await requireLockedBundle(service, slug, stagingVersion);
  const nowIso = new Date().toISOString();

  // Rows never seen this run get soft-removed at the staging version.
  // Count-based (not .select()): the update sets removed_in_version while the
  // filter requires it to be null, and PostgREST re-applies filters to the
  // RETURNING rows — a representation would always come back empty, reporting
  // removed=0 and skipping the version bump on removals-only publishes.
  const { count: removedCount } = await service
    .from("bundle_prospects")
    .update({ removed_in_version: stagingVersion, updated_at: nowIso }, { count: "exact" })
    .eq("bundle_id", bundle.id)
    .lt("version_last_seen", stagingVersion)
    .is("removed_in_version", null);
  const removed = removedCount ?? 0;

  // Company memberships not stamped by this run's chunks are stale — the
  // company dropped out of (or was renamed in) the source list. Hard delete:
  // memberships are pure display/provenance links (nothing user-owned
  // references them), so they don't need the prospects' soft-removal
  // machinery. NULL version_last_seen (rows predating CAR-63) prunes too —
  // a publish is a full snapshot, same as prospects.
  const { count: prunedCount } = await service
    .from("bundle_companies")
    .delete({ count: "exact" })
    .eq("bundle_id", bundle.id)
    .or(`version_last_seen.is.null,version_last_seen.lt.${stagingVersion}`);
  const companiesPruned = prunedCount ?? 0;

  // Anything to commit? Changed/added payloads or removals this run.
  const { count: changedCount } = await service
    .from("bundle_prospects")
    .select("id", { count: "exact", head: true })
    .eq("bundle_id", bundle.id)
    .eq("version_updated", stagingVersion);
  const hasChanges = (changedCount ?? 0) > 0 || removed > 0;

  const { count: liveCount } = await service
    .from("bundle_prospects")
    .select("id", { count: "exact", head: true })
    .eq("bundle_id", bundle.id)
    .is("removed_in_version", null);
  const { count: companyCount } = await service
    .from("bundle_companies")
    .select("id", { count: "exact", head: true })
    .eq("bundle_id", bundle.id);

  const patch: Record<string, unknown> = {
    staging_version: null,
    staging_claimed_at: null,
    prospect_count: liveCount ?? 0,
    company_count: companyCount ?? 0,
    status: "published",
    updated_at: nowIso,
  };
  if (hasChanges) {
    // Commit the version bump — this is the moment staged rows become
    // applicable to subscribers.
    patch.version = stagingVersion;
    patch.published_at = nowIso;
  }
  // Zero-change publish: skip the bump so subscribers see no delta and no
  // fan-out storm; counts/status still refresh (first publish of an empty
  // bundle stays at version 0 and simply isn't applicable yet).

  const { error } = await service.from("data_bundles").update(patch).eq("id", bundle.id);
  if (error) throw new BundlePublishError(`Finalize failed: ${error.message}`, 500);

  return {
    published: hasChanges,
    version: hasChanges ? stagingVersion : bundle.version,
    prospectCount: liveCount ?? 0,
    companyCount: companyCount ?? 0,
    removed,
    companiesPruned,
  };
}

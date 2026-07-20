/**
 * Bundle fast-apply path (CAR-62): a fully-resolved bundle applied to a
 * BLANK subscriber — zero contacts, zero import tombstones, first sync —
 * skips the merge engine entirely. Every prospect is a guaranteed create,
 * every entity id comes from the publish-time snapshot, so the whole apply
 * is a handful of bulk inserts instead of ~40 chunked merge rounds:
 * 2,000 prospects land in seconds.
 *
 * Dispatch lives in applyBundleDelta (cursor phase "fast"), so all four sync
 * drivers share this path and an interrupted run resumes from its persisted
 * checkpoint. This module must not import bundle-sync at runtime (that would
 * be an import cycle) — only its types.
 *
 * Correctness invariants preserved from the merge path:
 *  - bundle_contact_state rows are seeded with a fingerprint computed from
 *    the EXACT values inserted (same notes string, stored-normalized tag
 *    names) — a later fetchTouchSignals re-read must reproduce it, or the
 *    touched detector would refuse to ever clean these contacts up.
 *  - Any failure throws: the caller releases the sync claim, and the retry
 *    fails the zero-contact eligibility check, resuming on the idempotent
 *    merge path. (Contacts from a crashed batch get re-linked there as
 *    created_by_bundle=false — they survive unsubscribe, which errs toward
 *    keeping user data.)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "@/lib/data/client";
import type {
  ApplyStepResult,
  BundleCore,
  SubscriptionCore,
  SyncCheckpoint,
} from "./bundle-sync";
import { computeContactFingerprint, normalizeTagNames } from "./bundle-fingerprint";
import { parseBundleProspectPayload, payloadToMappedPerson } from "./bundle-payload";
import { readProspectResolution } from "./bundle-resolve";
import { buildContactInsertRow, educationDedupeKey, type ImportChunkOptions } from "./bulk-import";
import { addTagsToContacts, isValidImportEmail } from "./import-db-helpers";
import { chunkList } from "@/lib/data/postgrest";
import { createContacts } from "@/lib/data/contacts";
import type { QueryClient } from "@/lib/data/client";
import { normalizeLocation } from "./location-normalizer";
import { trackServer, checkContactMilestone } from "@/lib/analytics/server";

/** Prospects per fast-apply call. ~1,000 creates ≈ a few seconds of bulk
 * inserts — far inside the route's 60s window, and big enough that a full
 * 2,000-prospect bundle completes in two calls. */
export const FAST_APPLY_BATCH = 1000;

/** Rows per bulk INSERT statement (payload-size bound, not a perf knob). */
const INSERT_BATCH = 500;

/**
 * The fast path applies ONLY when nothing can possibly need merging:
 * first sync of the subscription, a snapshot covering the pinned version,
 * and a subscriber with no contacts, no suppression tombstones, and no
 * pre-existing tags. Everyone else takes the merge path — same result,
 * just slower.
 *
 * The zero-tags requirement guards a fingerprint-parity trap: the fast path
 * seeds bundle_contact_state from the LOWERCASED payload tag names, but
 * addTagsToContacts links to an already-existing tag under its stored casing
 * without rewriting it. A user owning a mixed-case tag ("APM") that collides
 * with a bundle tag ("apm") would get a baseline a later re-read can't
 * reproduce → the contact reads as user-touched forever. The merge path is
 * immune (it re-reads the created contact's real tag names), so those users
 * take it.
 */
export async function checkFastApplyEligibility(
  client: SupabaseClient,
  subscription: SubscriptionCore,
  bundle: BundleCore,
  pinnedVersion: number,
): Promise<boolean> {
  if (subscription.synced_version !== 0) return false;
  if (bundle.resolved_version !== bundle.version || bundle.version !== pinnedVersion) return false;

  const [{ count: contactCount }, { count: suppressedCount }, { count: tagCount }] = await Promise.all([
    client.from("contacts").select("*", { count: "exact", head: true }).eq("user_id", subscription.user_id),
    client
      .from("suppressed_imports")
      .select("*", { count: "exact", head: true })
      .eq("user_id", subscription.user_id),
    client.from("tags").select("*", { count: "exact", head: true }).eq("user_id", subscription.user_id),
  ]);
  return (contactCount ?? 0) === 0 && (suppressedCount ?? 0) === 0 && (tagCount ?? 0) === 0;
}

interface FastProspectRow {
  id: number;
  linkedin_url: string;
  payload: unknown;
  payload_schema_version: number;
  payload_hash: string;
  resolved: unknown;
}

/** Best-effort checkpoint write, mirroring bundle-sync's persistSyncCheckpoint
 * (inlined here to avoid a runtime import cycle). */
async function persistFastCheckpoint(
  client: SupabaseClient,
  subscriptionId: number,
  checkpoint: SyncCheckpoint,
): Promise<void> {
  await client.from("bundle_subscriptions").update({ sync_cursor: checkpoint }).eq("id", subscriptionId);
}

export async function runFastApplyStep(
  client: SupabaseClient,
  subscription: SubscriptionCore,
  bundle: BundleCore,
  opts: {
    afterId: number;
    pinnedVersion: number;
    /** Hand analytics work off instead of awaiting it inline — see
     * applyBundleDelta (CAR-78). Absent → awaited, as before. */
    deferAnalytics?: (p: Promise<unknown>) => void;
  },
): Promise<ApplyStepResult> {
  const { afterId, pinnedVersion } = opts;
  const now = new Date().toISOString();
  const result: ApplyStepResult = {
    done: false,
    nextCursor: null,
    pinnedVersion,
    applied: 0,
    removedContacts: 0,
    orphanedLinks: 0,
    skipped: [],
    path: "fast",
  };

  // Same delta bounds as the merge path with synced_version = 0.
  const rows = must(
    await client
      .from("bundle_prospects")
      .select("id, linkedin_url, payload, payload_schema_version, payload_hash, resolved")
      .eq("bundle_id", bundle.id)
      .gt("version_updated", 0)
      .lte("version_updated", pinnedVersion)
      .or(`removed_in_version.is.null,removed_in_version.gt.${pinnedVersion}`)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(FAST_APPLY_BATCH),
  );
  const prospects = (rows as FastProspectRow[] | null) ?? [];

  const importOpts: ImportChunkOptions = {
    mergePolicy: "bundle",
    skipPhotos: true,
    noteLabel: `Imported from data bundle "${bundle.name}"`,
  };

  // ── Parse + validate every row up front ──
  const pending: Array<{
    row: FastProspectRow;
    mapped: ReturnType<typeof payloadToMappedPerson>;
    contactRow: Record<string, unknown>;
    contactId?: number;
  }> = [];
  for (const row of prospects) {
    const parsed = parseBundleProspectPayload(row.payload, row.payload_schema_version);
    if (!parsed.ok) {
      result.skipped.push(`${row.linkedin_url}: ${parsed.reason}`);
      continue;
    }
    const resolution = readProspectResolution(row.resolved, row.payload_hash);
    if (!resolution) {
      // Shouldn't happen behind the resolved_version gate; belt only.
      result.skipped.push(`${row.linkedin_url}: missing_resolution`);
      continue;
    }
    const mapped = payloadToMappedPerson(
      parsed.payload,
      { bundleId: bundle.id, bundleSlug: bundle.slug, bundleVersion: pinnedVersion },
      resolution,
    );
    pending.push({
      row,
      mapped,
      contactRow: buildContactInsertRow(
        subscription.user_id,
        mapped,
        mapped.resolved_profile_location_id ?? null,
        now,
        importOpts,
      ),
    });
  }

  // ── Contacts: bulk insert, ids mapped back from RETURNING ──
  // Batches are independent (each maps its own RETURNING rows), so they run
  // concurrently (CAR-78) — a failure in any batch still throws.
  await Promise.all(
    chunkList(pending, INSERT_BATCH).map(async (batch) => {
      // Shared write chokepoint (CAR-155): canonicalization runs inside.
      let createdRows: Array<{ id: number; linkedin_url: string | null }>;
      try {
        createdRows = (await createContacts(
          batch.map((p) => p.contactRow) as unknown as Parameters<typeof createContacts>[0],
          { client: client as unknown as QueryClient },
        )) as Array<{ id: number; linkedin_url: string | null }>;
      } catch (err) {
        // PostgREST errors are message-bearing objects, not Error instances.
        throw new Error(`Fast apply contact insert failed: ${(err as { message?: string })?.message ?? String(err)}`);
      }
      if (createdRows.length !== batch.length) {
        throw new Error(`Fast apply contact insert failed: short RETURNING`);
      }
      // RETURNING preserves VALUES order in Postgres; the URL cross-check
      // guards the assumption (URLs are unique within a bundle).
      const positional = createdRows.every((r, i) => r.linkedin_url === batch[i].mapped.linkedin_url);
      const byUrl = positional ? null : new Map(createdRows.map((r) => [r.linkedin_url, r.id]));
      for (let i = 0; i < batch.length; i++) {
        const id = positional ? createdRows[i].id : byUrl!.get(batch[i].mapped.linkedin_url);
        if (id == null) throw new Error("Fast apply contact insert failed: unmatched RETURNING row");
        batch[i].contactId = id;
      }
    }),
  );

  // ── Children, linkage, and state — pure row-building, then bulk writes ──
  const employmentRows: Record<string, unknown>[] = [];
  const educationRows: Record<string, unknown>[] = [];
  const emailRows: Record<string, unknown>[] = [];
  const tagsByContact = new Map<number, string[]>();
  const linkRows: Record<string, unknown>[] = [];
  const stateRows: Record<string, unknown>[] = [];

  for (const p of pending) {
    const contactId = p.contactId!;

    for (const emp of p.mapped.employment) {
      // resolved_company_id is guaranteed by readProspectResolution.
      const isRemote =
        emp.workplace_type === "remote" ||
        Boolean((emp.location_raw ? normalizeLocation(emp.location_raw) : null)?.isRemote);
      employmentRows.push({
        contact_id: contactId,
        company_id: emp.resolved_company_id,
        title: emp.title,
        start_month: emp.start_month,
        end_month: emp.end_month,
        is_current: emp.is_current,
        location_id: emp.resolved_location_id ?? null,
        location_source: emp.resolved_location_id != null ? (emp.resolved_location_source ?? null) : null,
        location_raw: emp.location_raw,
        workplace_type: isRemote ? "remote" : emp.workplace_type,
        employment_type: emp.employment_type,
        source: "scraped",
        scraped_at: now,
      });
    }

    const eduKeys = new Set<string>();
    for (const edu of p.mapped.education) {
      if (edu.resolved_school_id == null) continue;
      // Shared dedupe key (NULL-start_year-aware) — same rule the merge path
      // uses, so the two paths never disagree on what counts as a duplicate.
      const key = educationDedupeKey(edu.resolved_school_id, edu.start_year, edu.degree, edu.field_of_study);
      if (eduKeys.has(key)) continue;
      eduKeys.add(key);
      educationRows.push({
        contact_id: contactId,
        school_id: edu.resolved_school_id,
        degree: edu.degree,
        field_of_study: edu.field_of_study,
        start_year: edu.start_year,
        end_year: edu.end_year,
      });
    }

    if (p.mapped.email && isValidImportEmail(p.mapped.email.address)) {
      emailRows.push({
        contact_id: contactId,
        email: p.mapped.email.address,
        is_primary: true,
        source: p.mapped.email.source,
      });
    }

    if (p.mapped.tags.length > 0) tagsByContact.set(contactId, p.mapped.tags);

    linkRows.push({
      subscription_id: subscription.id,
      contact_id: contactId,
      bundle_prospect_id: p.row.id,
      linkedin_url: p.mapped.linkedin_url,
      created_by_bundle: true,
      first_applied_version: pinnedVersion,
      last_applied_version: pinnedVersion,
      last_applied_at: now,
    });

    // Fingerprint parity: read the baseline off the EXACT contact row we
    // inserted, with tags as addTagsToContacts stores them. fetchTouchSignals
    // must reproduce this hash from the DB or touched-detection breaks.
    stateRows.push({
      user_id: subscription.user_id,
      contact_id: contactId,
      applied_fingerprint: computeContactFingerprint({
        name: (p.contactRow.name as string | null) ?? null,
        headline: (p.contactRow.headline as string | null) ?? null,
        notes: (p.contactRow.notes as string | null) ?? null,
        persona: (p.contactRow.persona as string | null) ?? null,
        network_status: (p.contactRow.network_status as string | null) ?? null,
        stage_override: null,
        manual_employment_keys: [],
        manual_emails: [],
        tags: normalizeTagNames(p.mapped.tags),
      }),
      user_touched: false,
      apply_started_at: null,
      updated_at: now,
    });
  }

  const bulkInsert = async (table: string, tableRows: Record<string, unknown>[]) => {
    // Dynamic table names are invisible to the contact-write-chokepoint
    // source scan, so refuse the contacts table here: those writes must go
    // through createContact/createContacts (CAR-155).
    if (table === "contacts") throw new Error("bulkInsert must not write contacts — use createContacts");
    for (const batch of chunkList(tableRows, INSERT_BATCH)) {
      const { error } = await client.from(table).insert(batch);
      if (error) throw new Error(`Fast apply ${table} insert failed: ${error.message}`);
    }
  };

  await Promise.all([
    bulkInsert("contact_companies", employmentRows),
    // Ignore-duplicates upsert on the unique index — same-school/same-year
    // payload pairs (double majors) must not fail the batch (CAR-62).
    (async () => {
      for (const batch of chunkList(educationRows, INSERT_BATCH)) {
        const { error } = await client
          .from("contact_schools")
          .upsert(batch, { onConflict: "contact_id,school_id,start_year", ignoreDuplicates: true });
        if (error) throw new Error(`Fast apply contact_schools upsert failed: ${error.message}`);
      }
    })(),
    bulkInsert("contact_emails", emailRows),
    bulkInsert("bundle_subscription_contacts", linkRows),
    bulkInsert("bundle_contact_state", stateRows),
    addTagsToContacts(client, subscription.user_id, tagsByContact),
  ]);

  result.applied = pending.length;
  if (result.applied > 0) {
    const capture = trackServer(subscription.user_id, "contact_imported", {
      source: "bundle",
      count: result.applied,
      fast: true,
    });
    if (opts.deferAnalytics) opts.deferAnalytics(capture);
    else await capture;
  }

  if (prospects.length === FAST_APPLY_BATCH) {
    result.nextCursor = { phase: "fast", afterId: prospects[prospects.length - 1].id };
    await persistFastCheckpoint(client, subscription.id, { ...result.nextCursor, pinnedVersion }).catch(() => {});
    return result;
  }

  // A blank subscriber's removal phase is vacuously empty (no linkage rows
  // can reference removed prospects), so commit the sync directly.
  await client
    .from("bundle_subscriptions")
    .update({ synced_version: pinnedVersion, last_synced_at: now, sync_cursor: null, updated_at: now })
    .eq("id", subscription.id);
  const milestone = checkContactMilestone(subscription.user_id);
  if (opts.deferAnalytics) opts.deferAnalytics(milestone);
  else await milestone;
  result.done = true;
  return result;
}

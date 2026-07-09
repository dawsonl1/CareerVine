/**
 * Bundle subscription sync core (plan 29 §5).
 *
 * applyBundleDelta copies a bundle's prospect delta into one subscriber's
 * contacts through the import engine's 'bundle' merge policy, then
 * processes bundle removals. It is driven in cursor chunks by four
 * callers — the user-driven apply route, the QStash fan-out worker, the
 * daily cron safety net, and the Settings opportunistic self-sync — and
 * is safe under all of them because of three mechanisms:
 *
 *  1. SERIALIZATION CLAIM: callers must hold bundle_subscriptions.
 *     sync_claimed_until (CAS-renewed via claim tokens), so two drivers
 *     can never interleave on one subscription.
 *  2. PINNED VERSIONS: the delta is bounded by the committed bundle
 *     version pinned at sync start; synced_version advances exactly to
 *     the pin, only when both phases complete. Staged publish rows are
 *     unreachable; interrupted syncs resume idempotently.
 *  3. DETERMINISTIC TOUCHED STATE: bundle_contact_state (per user+contact,
 *     shared across ALL subscriptions) holds a fingerprint of the
 *     user-editable surface + a sticky user_touched flag. Fingerprint
 *     drift between applies marks the contact touched; bundle applies
 *     refresh the baseline from the pre-snapshot + merge results (never a
 *     re-read), and interrupted applies (apply_started_at still set)
 *     refresh WITHOUT promoting drift — a one-run false negative beats a
 *     permanently poisoned flag. No wall-clock heuristics gate deletion.
 *
 * Deletion rules (removal phase and unsubscribe): a contact is deleted
 * ONLY IF the bundle created it AND it is untouched AND no other active
 * subscription of this user links it. Everything else just drops the
 * linkage row, orphaning the contact into the user's normal contacts.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseBundleProspectPayload, payloadToMappedPerson } from "./bundle-payload";
import { importPeopleChunk, type PersonImportResult } from "./bulk-import";
import { stableStringify } from "./bundle-publish";

export const SYNC_CLAIM_MS = 2 * 60 * 1000;
export const SYNC_CHUNK_SIZE = 50;

export interface BundleCore {
  id: number;
  slug: string;
  name: string;
  version: number;
}

export interface SubscriptionCore {
  id: number;
  user_id: string;
  bundle_id: number;
  status: string;
  synced_version: number;
}

export interface ApplyCursor {
  phase: "apply" | "remove";
  afterId: number;
}

export interface ApplyStepResult {
  done: boolean;
  nextCursor: ApplyCursor | null;
  pinnedVersion: number;
  applied: number;
  removedContacts: number;
  orphanedLinks: number;
  skipped: string[];
}

// ── Serialization claim (CAS via claim tokens) ─────────────────────────

/**
 * Claim (or CAS-renew with priorToken) the subscription's sync slot.
 * Returns the new token, or null when another driver holds an unexpired
 * claim — callers must then back off entirely.
 */
export async function claimSubscriptionSync(
  client: SupabaseClient,
  subscriptionId: number,
  priorToken?: string | null,
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const token = new Date(Date.now() + SYNC_CLAIM_MS).toISOString();

  let query = client
    .from("bundle_subscriptions")
    .update({ sync_claimed_until: token, updated_at: nowIso })
    .eq("id", subscriptionId);
  query = priorToken
    ? query.eq("sync_claimed_until", priorToken)
    : query.or(`sync_claimed_until.is.null,sync_claimed_until.lt.${nowIso}`);

  const { data } = await query.select("id").maybeSingle();
  return data ? token : null;
}

export async function releaseSubscriptionSync(
  client: SupabaseClient,
  subscriptionId: number,
  token: string,
): Promise<void> {
  await client
    .from("bundle_subscriptions")
    .update({ sync_claimed_until: null })
    .eq("id", subscriptionId)
    .eq("sync_claimed_until", token);
}

// ── Fingerprints & touched detection (pure) ────────────────────────────

/** The user-editable surface the fingerprint covers. EXCLUDES everything
 * the importer writes outside the fingerprint-refresh window (photo_url,
 * last_scraped_at, provenance, scraped-source child rows) — those changing
 * must never read as user edits. */
export interface ContactFingerprintInput {
  name: string | null;
  headline: string | null;
  notes: string | null;
  persona: string | null;
  network_status: string | null;
  stage_override: string | null;
  /** employmentKey()s of contact_companies rows with source='manual'. */
  manual_employment_keys: string[];
  /** Addresses of contact_emails rows with source='manual'. */
  manual_emails: string[];
  /** All tag names on the contact. */
  tags: string[];
}

export function computeContactFingerprint(input: ContactFingerprintInput): string {
  const canonical = {
    name: input.name ?? null,
    headline: input.headline ?? null,
    notes: input.notes ?? null,
    persona: input.persona ?? null,
    network_status: input.network_status ?? null,
    stage_override: input.stage_override ?? null,
    manual_employment_keys: [...input.manual_employment_keys].sort(),
    manual_emails: [...input.manual_emails].map((e) => e.toLowerCase()).sort(),
    tags: [...input.tags].sort(),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export interface ContactStateRow {
  contact_id: number;
  applied_fingerprint: string | null;
  user_touched: boolean;
  apply_started_at: string | null;
}

export interface HardSignals {
  interactions: number;
  meetings: number;
  followUps: number;
}

/**
 * Deterministic touched decision. Missing state (no baseline) is treated
 * as touched — never delete a contact we have no fingerprint history for.
 */
export function isContactTouched(
  state: ContactStateRow | null | undefined,
  hardSignals: HardSignals,
  currentFingerprint: string,
): boolean {
  if (hardSignals.interactions > 0 || hardSignals.meetings > 0 || hardSignals.followUps > 0) return true;
  if (!state || state.applied_fingerprint == null) return true;
  if (state.user_touched) return true;
  return currentFingerprint !== state.applied_fingerprint;
}

// ── Signal loading ─────────────────────────────────────────────────────

export interface ContactSnapshot extends ContactFingerprintInput {
  id: number;
  linkedin_url: string | null;
}

export interface TouchSignalSet {
  snapshots: Map<number, ContactSnapshot>;
  hardSignals: Map<number, HardSignals>;
  states: Map<number, ContactStateRow>;
}

const employmentKeyOf = (r: { company_id: number; title: string | null; start_month: string | null }) =>
  `${r.company_id}|${(r.title ?? "").trim().toLowerCase()}|${(r.start_month ?? "").trim().toLowerCase()}`;

/** Batch-load everything touched detection needs for a set of contacts. */
export async function fetchTouchSignals(
  client: SupabaseClient,
  userId: string,
  contactIds: number[],
): Promise<TouchSignalSet> {
  const result: TouchSignalSet = { snapshots: new Map(), hardSignals: new Map(), states: new Map() };
  if (contactIds.length === 0) return result;

  const [contacts, manualEmp, manualEmails, tagRows, interactions, meetings, followUps, states] =
    await Promise.all([
      client
        .from("contacts")
        .select("id, linkedin_url, name, headline, notes, persona, network_status, stage_override")
        .eq("user_id", userId)
        .in("id", contactIds),
      client
        .from("contact_companies")
        .select("contact_id, company_id, title, start_month")
        .eq("source", "manual")
        .in("contact_id", contactIds),
      client
        .from("contact_emails")
        .select("contact_id, email")
        .eq("source", "manual")
        .in("contact_id", contactIds),
      client.from("contact_tags").select("contact_id, tags(name)").in("contact_id", contactIds),
      client.from("interactions").select("contact_id").in("contact_id", contactIds),
      client.from("meeting_contacts").select("contact_id").in("contact_id", contactIds),
      client.from("follow_up_action_items").select("contact_id").in("contact_id", contactIds),
      client
        .from("bundle_contact_state")
        .select("contact_id, applied_fingerprint, user_touched, apply_started_at")
        .eq("user_id", userId)
        .in("contact_id", contactIds),
    ]);

  for (const row of (contacts.data as Array<Record<string, unknown>> | null) ?? []) {
    result.snapshots.set(row.id as number, {
      id: row.id as number,
      linkedin_url: (row.linkedin_url as string | null) ?? null,
      name: (row.name as string | null) ?? null,
      headline: (row.headline as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      persona: (row.persona as string | null) ?? null,
      network_status: (row.network_status as string | null) ?? null,
      stage_override: (row.stage_override as string | null) ?? null,
      manual_employment_keys: [],
      manual_emails: [],
      tags: [],
    });
    result.hardSignals.set(row.id as number, { interactions: 0, meetings: 0, followUps: 0 });
  }

  for (const row of (manualEmp.data as Array<{ contact_id: number; company_id: number; title: string | null; start_month: string | null }> | null) ?? []) {
    result.snapshots.get(row.contact_id)?.manual_employment_keys.push(employmentKeyOf(row));
  }
  for (const row of (manualEmails.data as Array<{ contact_id: number; email: string | null }> | null) ?? []) {
    if (row.email) result.snapshots.get(row.contact_id)?.manual_emails.push(row.email);
  }
  for (const row of (tagRows.data as Array<{ contact_id: number; tags: { name: string } | { name: string }[] | null }> | null) ?? []) {
    const names = Array.isArray(row.tags) ? row.tags.map((t) => t.name) : row.tags ? [row.tags.name] : [];
    result.snapshots.get(row.contact_id)?.tags.push(...names);
  }
  const bump = (map: Map<number, HardSignals>, id: number, key: keyof HardSignals) => {
    const s = map.get(id);
    if (s) s[key]++;
  };
  for (const row of (interactions.data as Array<{ contact_id: number }> | null) ?? []) bump(result.hardSignals, row.contact_id, "interactions");
  for (const row of (meetings.data as Array<{ contact_id: number }> | null) ?? []) bump(result.hardSignals, row.contact_id, "meetings");
  for (const row of (followUps.data as Array<{ contact_id: number }> | null) ?? []) bump(result.hardSignals, row.contact_id, "followUps");
  for (const row of (states.data as ContactStateRow[] | null) ?? []) result.states.set(row.contact_id, row);

  return result;
}

// ── Sibling protection ─────────────────────────────────────────────────

/** Contacts (of the given set) still linked by ANOTHER active subscription
 * of the same user — these must never be deleted by this subscription. */
export async function findSiblingLinkedContacts(
  client: SupabaseClient,
  userId: string,
  excludeSubscriptionId: number,
  contactIds: number[],
): Promise<Set<number>> {
  if (contactIds.length === 0) return new Set();
  const { data } = await client
    .from("bundle_subscription_contacts")
    .select("contact_id, bundle_subscriptions!inner(user_id, status)")
    .neq("subscription_id", excludeSubscriptionId)
    .in("contact_id", contactIds)
    .eq("bundle_subscriptions.user_id", userId)
    .eq("bundle_subscriptions.status", "active");
  return new Set(((data as Array<{ contact_id: number }> | null) ?? []).map((r) => r.contact_id));
}

// ── Post-apply fingerprint (from pre-snapshot + merge results) ─────────

/** Compute the post-apply fingerprint for an UPDATED contact without
 * re-reading the DB: pre-snapshot + the patch the importer applied + the
 * additive tag merge. Bundle policy never touches notes/persona/stage
 * on merge and never creates manual rows. */
export function postApplyFingerprint(
  pre: ContactFingerprintInput,
  appliedPatch: Record<string, unknown>,
  payloadTags: string[],
): string {
  return computeContactFingerprint({
    ...pre,
    name: (appliedPatch.name as string | undefined) ?? pre.name,
    headline: (appliedPatch.headline as string | undefined) ?? pre.headline,
    network_status: (appliedPatch.network_status as string | undefined) ?? pre.network_status,
    tags: [...new Set([...pre.tags, ...payloadTags])],
  });
}

// ── Core delta application ─────────────────────────────────────────────

interface ProspectRow {
  id: number;
  linkedin_url: string;
  payload: unknown;
  payload_schema_version: number;
}

export async function applyBundleDelta(
  client: SupabaseClient,
  subscription: SubscriptionCore,
  bundle: BundleCore,
  opts: { cursor?: ApplyCursor | null; pinnedVersion?: number; chunkSize?: number } = {},
): Promise<ApplyStepResult> {
  const pinnedVersion = opts.pinnedVersion ?? bundle.version;
  const chunkSize = opts.chunkSize ?? SYNC_CHUNK_SIZE;
  const cursor: ApplyCursor = opts.cursor ?? { phase: "apply", afterId: 0 };
  const nowIso = new Date().toISOString();
  const result: ApplyStepResult = {
    done: false,
    nextCursor: null,
    pinnedVersion,
    applied: 0,
    removedContacts: 0,
    orphanedLinks: 0,
    skipped: [],
  };

  if (cursor.phase === "apply") {
    const { data: rows } = await client
      .from("bundle_prospects")
      .select("id, linkedin_url, payload, payload_schema_version")
      .eq("bundle_id", bundle.id)
      .gt("version_updated", subscription.synced_version)
      .lte("version_updated", pinnedVersion)
      .or(`removed_in_version.is.null,removed_in_version.gt.${pinnedVersion}`)
      .gt("id", cursor.afterId)
      .order("id", { ascending: true })
      .limit(chunkSize);
    const prospects = (rows as ProspectRow[] | null) ?? [];

    if (prospects.length > 0) {
      // Parse payloads; unknown versions / bad rows are reported, not fatal.
      const parsed: Array<{ row: ProspectRow; mapped: ReturnType<typeof payloadToMappedPerson> }> = [];
      for (const row of prospects) {
        const p = parseBundleProspectPayload(row.payload, row.payload_schema_version);
        if (!p.ok) {
          result.skipped.push(`${row.linkedin_url}: ${p.reason}`);
          continue;
        }
        parsed.push({
          row,
          mapped: payloadToMappedPerson(p.payload, {
            bundleId: bundle.id,
            bundleSlug: bundle.slug,
            bundleVersion: pinnedVersion,
          }),
        });
      }

      // Pre-apply fingerprint pass over contacts that already exist.
      const urls = parsed.map((p) => p.mapped.linkedin_url);
      const { data: existingContacts } = await client
        .from("contacts")
        .select("id, linkedin_url")
        .eq("user_id", subscription.user_id)
        .in("linkedin_url", urls);
      const existingIds = ((existingContacts as Array<{ id: number }> | null) ?? []).map((c) => c.id);
      const signals = await fetchTouchSignals(client, subscription.user_id, existingIds);

      const stateUpserts: Record<string, unknown>[] = [];
      for (const [contactId, snapshot] of signals.snapshots) {
        const state = signals.states.get(contactId);
        const currentFp = computeContactFingerprint(snapshot);
        const interrupted = Boolean(state?.apply_started_at);
        const drifted = state?.applied_fingerprint != null && state.applied_fingerprint !== currentFp;
        stateUpserts.push({
          user_id: subscription.user_id,
          contact_id: contactId,
          // Interrupted prior apply: refresh the baseline without promoting
          // drift — the merge's own writes must not read as user edits.
          user_touched: (state?.user_touched ?? false) || (drifted && !interrupted),
          applied_fingerprint: state?.applied_fingerprint ?? null,
          apply_started_at: nowIso,
          updated_at: nowIso,
        });
      }
      if (stateUpserts.length > 0) {
        await client.from("bundle_contact_state").upsert(stateUpserts, { onConflict: "user_id,contact_id" });
      }

      // The actual import (fill-empty bundle policy, no photos).
      const summary = await importPeopleChunk(
        client,
        subscription.user_id,
        parsed.map((p) => ({ mapped: p.mapped })),
        {
          mergePolicy: "bundle",
          skipPhotos: true,
          noteLabel: `Imported from data bundle "${bundle.name}"`,
        },
      );

      // Linkage + fingerprint bookkeeping from results.
      const byUrl = new Map(parsed.map((p) => [p.mapped.linkedin_url, p]));
      const resultsWithContacts = summary.results.filter(
        (r): r is PersonImportResult & { contact_id: number } =>
          typeof r.contact_id === "number" && (r.status === "created" || r.status === "updated"),
      );
      for (const r of summary.results) {
        if (r.status === "skipped_suppressed") result.skipped.push(`${r.linkedin_url}: suppressed`);
        if (r.status === "error") result.skipped.push(`${r.linkedin_url}: ${r.error}`);
      }
      result.applied = resultsWithContacts.length;

      const createdIds = resultsWithContacts.filter((r) => r.status === "created").map((r) => r.contact_id);
      // Created contacts have no pre-snapshot; establish their baseline from
      // a fresh read (safe: the row is seconds old and owned by this run).
      const createdSignals = await fetchTouchSignals(client, subscription.user_id, createdIds);

      const { data: existingLinks } = await client
        .from("bundle_subscription_contacts")
        .select("contact_id")
        .eq("subscription_id", subscription.id)
        .in("contact_id", resultsWithContacts.map((r) => r.contact_id));
      const linkedAlready = new Set(((existingLinks as Array<{ contact_id: number }> | null) ?? []).map((l) => l.contact_id));

      const linkInserts: Record<string, unknown>[] = [];
      const finalStateUpserts: Record<string, unknown>[] = [];
      for (const r of resultsWithContacts) {
        const p = r.linkedin_url ? byUrl.get(r.linkedin_url) : undefined;
        if (!linkedAlready.has(r.contact_id)) {
          linkInserts.push({
            subscription_id: subscription.id,
            contact_id: r.contact_id,
            bundle_prospect_id: p?.row.id ?? null,
            linkedin_url: r.linkedin_url ?? "",
            created_by_bundle: r.status === "created",
            first_applied_version: pinnedVersion,
            last_applied_version: pinnedVersion,
            last_applied_at: nowIso,
          });
        } else {
          await client
            .from("bundle_subscription_contacts")
            .update({ last_applied_version: pinnedVersion, last_applied_at: nowIso, bundle_prospect_id: p?.row.id ?? null })
            .eq("subscription_id", subscription.id)
            .eq("contact_id", r.contact_id);
        }

        // Post-apply fingerprint: created → fresh baseline read; updated →
        // pre-snapshot + applied patch (no re-read).
        let fp: string | null = null;
        if (r.status === "created") {
          const snap = createdSignals.snapshots.get(r.contact_id);
          if (snap) fp = computeContactFingerprint(snap);
        } else {
          const pre = signals.snapshots.get(r.contact_id);
          if (pre) fp = postApplyFingerprint(pre, r.applied_patch ?? {}, p?.mapped.tags ?? []);
        }
        const priorState = signals.states.get(r.contact_id);
        const currentFp = signals.snapshots.get(r.contact_id)
          ? computeContactFingerprint(signals.snapshots.get(r.contact_id)!)
          : null;
        const interrupted = Boolean(priorState?.apply_started_at);
        const drifted =
          priorState?.applied_fingerprint != null && currentFp != null && priorState.applied_fingerprint !== currentFp;
        finalStateUpserts.push({
          user_id: subscription.user_id,
          contact_id: r.contact_id,
          applied_fingerprint: fp,
          user_touched: (priorState?.user_touched ?? false) || (drifted && !interrupted),
          apply_started_at: null,
          updated_at: nowIso,
        });
      }
      if (linkInserts.length > 0) {
        const { error } = await client.from("bundle_subscription_contacts").insert(linkInserts);
        if (error) throw new Error(`Linkage insert failed: ${error.message}`);
      }
      if (finalStateUpserts.length > 0) {
        await client.from("bundle_contact_state").upsert(finalStateUpserts, { onConflict: "user_id,contact_id" });
      }
    }

    if (prospects.length === chunkSize) {
      result.nextCursor = { phase: "apply", afterId: prospects[prospects.length - 1].id };
      return result;
    }
    // Apply phase exhausted → removal phase in the same call only when the
    // apply chunk was empty; otherwise hand back a cursor so each HTTP call
    // stays bounded.
    if (prospects.length > 0) {
      result.nextCursor = { phase: "remove", afterId: 0 };
      return result;
    }
  }

  // ── Removal phase ──
  const removeAfter = cursor.phase === "remove" ? cursor.afterId : 0;
  const { data: removedRows } = await client
    .from("bundle_prospects")
    .select("id, linkedin_url")
    .eq("bundle_id", bundle.id)
    .gt("removed_in_version", subscription.synced_version)
    .lte("removed_in_version", pinnedVersion)
    .gt("id", removeAfter)
    .order("id", { ascending: true })
    .limit(chunkSize);
  const removed = (removedRows as Array<{ id: number; linkedin_url: string }> | null) ?? [];

  if (removed.length > 0) {
    const { data: links } = await client
      .from("bundle_subscription_contacts")
      .select("id, contact_id, created_by_bundle, bundle_prospect_id")
      .eq("subscription_id", subscription.id)
      .in("bundle_prospect_id", removed.map((r) => r.id));
    const linkRows = (links as Array<{ id: number; contact_id: number; created_by_bundle: boolean; bundle_prospect_id: number }> | null) ?? [];

    const candidateIds = linkRows.filter((l) => l.created_by_bundle).map((l) => l.contact_id);
    const [signals, siblingLinked] = await Promise.all([
      fetchTouchSignals(client, subscription.user_id, candidateIds),
      findSiblingLinkedContacts(client, subscription.user_id, subscription.id, candidateIds),
    ]);

    const contactIdsToDelete: number[] = [];
    const linkIdsToDrop: number[] = [];
    for (const link of linkRows) {
      if (link.created_by_bundle && !siblingLinked.has(link.contact_id)) {
        const snapshot = signals.snapshots.get(link.contact_id);
        const touched =
          !snapshot ||
          isContactTouched(
            signals.states.get(link.contact_id),
            signals.hardSignals.get(link.contact_id) ?? { interactions: 0, meetings: 0, followUps: 0 },
            computeContactFingerprint(snapshot),
          );
        if (!touched) {
          contactIdsToDelete.push(link.contact_id);
          continue; // linkage + state cascade with the contact
        }
      }
      linkIdsToDrop.push(link.id);
    }

    if (contactIdsToDelete.length > 0) {
      // Scoped by user_id as defense in depth for service-client callers.
      // No suppressed_imports tombstone: the prospect left the bundle, so
      // nothing re-imports it; tombstoning would poison future bundles.
      const { error } = await client
        .from("contacts")
        .delete()
        .eq("user_id", subscription.user_id)
        .in("id", contactIdsToDelete);
      if (error) throw new Error(`Removal delete failed: ${error.message}`);
      result.removedContacts = contactIdsToDelete.length;
    }
    if (linkIdsToDrop.length > 0) {
      await client.from("bundle_subscription_contacts").delete().in("id", linkIdsToDrop);
      result.orphanedLinks = linkIdsToDrop.length;
    }
  }

  if (removed.length === chunkSize) {
    result.nextCursor = { phase: "remove", afterId: removed[removed.length - 1].id };
    return result;
  }

  // ── Both phases complete: commit the sync ──
  await client
    .from("bundle_subscriptions")
    .update({ synced_version: pinnedVersion, last_synced_at: nowIso, updated_at: nowIso })
    .eq("id", subscription.id);
  result.done = true;
  return result;
}

// ── Unsubscribe ────────────────────────────────────────────────────────

export interface UnsubscribeStepResult {
  done: boolean;
  nextCursor: number | null;
  removed: number;
  kept: number;
}

/**
 * Unsubscribe from a bundle (plan 29 §7). The subscription row is kept
 * with status='unsubscribed' (clean resubscribe via the UNIQUE constraint;
 * sync drivers skip inactive rows, so flipping status first also fences
 * out concurrent background syncs).
 *
 * keepAll=true drops all linkage rows — every imported contact becomes a
 * plain contact. keepAll=false deletes bundle-created contacts that are
 * untouched AND not linked by any sibling active subscription; everything
 * else is orphaned. Cursor-looped like apply so huge subscriptions stay
 * inside function limits. NEVER writes suppressed_imports: sync only runs
 * for active subscriptions, and tombstoning here would poison resubscribe.
 */
export async function unsubscribeFromBundle(
  client: SupabaseClient,
  subscription: SubscriptionCore,
  opts: { keepAll: boolean; cursor?: number | null; chunkSize?: number },
): Promise<UnsubscribeStepResult> {
  const chunkSize = opts.chunkSize ?? SYNC_CHUNK_SIZE;
  const nowIso = new Date().toISOString();
  const result: UnsubscribeStepResult = { done: false, nextCursor: null, removed: 0, kept: 0 };

  // First call: fence out background syncs before touching linkage.
  if (!opts.cursor) {
    await client
      .from("bundle_subscriptions")
      .update({ status: "unsubscribed", sync_claimed_until: null, updated_at: nowIso })
      .eq("id", subscription.id);
  }

  if (opts.keepAll) {
    const { data: dropped } = await client
      .from("bundle_subscription_contacts")
      .delete()
      .eq("subscription_id", subscription.id)
      .select("id");
    result.kept = ((dropped as { id: number }[] | null) ?? []).length;
    result.done = true;
    return result;
  }

  const { data: linkRows } = await client
    .from("bundle_subscription_contacts")
    .select("id, contact_id, created_by_bundle")
    .eq("subscription_id", subscription.id)
    .gt("id", opts.cursor ?? 0)
    .order("id", { ascending: true })
    .limit(chunkSize);
  const links = (linkRows as Array<{ id: number; contact_id: number; created_by_bundle: boolean }> | null) ?? [];

  if (links.length > 0) {
    const candidateIds = links.filter((l) => l.created_by_bundle).map((l) => l.contact_id);
    const [signals, siblingLinked] = await Promise.all([
      fetchTouchSignals(client, subscription.user_id, candidateIds),
      findSiblingLinkedContacts(client, subscription.user_id, subscription.id, candidateIds),
    ]);

    const contactIdsToDelete: number[] = [];
    const linkIdsToDrop: number[] = [];
    for (const link of links) {
      if (link.created_by_bundle && !siblingLinked.has(link.contact_id)) {
        const snapshot = signals.snapshots.get(link.contact_id);
        const touched =
          !snapshot ||
          isContactTouched(
            signals.states.get(link.contact_id),
            signals.hardSignals.get(link.contact_id) ?? { interactions: 0, meetings: 0, followUps: 0 },
            computeContactFingerprint(snapshot),
          );
        if (!touched) {
          contactIdsToDelete.push(link.contact_id);
          continue; // linkage + state cascade with the contact
        }
      }
      linkIdsToDrop.push(link.id);
    }

    if (contactIdsToDelete.length > 0) {
      const { error } = await client
        .from("contacts")
        .delete()
        .eq("user_id", subscription.user_id)
        .in("id", contactIdsToDelete);
      if (error) throw new Error(`Unsubscribe delete failed: ${error.message}`);
      result.removed = contactIdsToDelete.length;
    }
    if (linkIdsToDrop.length > 0) {
      await client.from("bundle_subscription_contacts").delete().in("id", linkIdsToDrop);
      result.kept = linkIdsToDrop.length;
    }
  }

  if (links.length === chunkSize) {
    result.nextCursor = links[links.length - 1].id;
    return result;
  }
  result.done = true;
  return result;
}

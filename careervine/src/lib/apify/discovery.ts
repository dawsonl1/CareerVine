/**
 * Discovery feed (plan 41 / CAR-29): weekly search for new PM hires at
 * high-priority target companies, surfaced as candidate contacts.
 *
 *   select — eligible targeted companies (LinkedIn URL present, stalest
 *     first, min re-query age, no pending discovery run).
 *   trigger — per company: soft/hard cap checks → pending scrape_runs row
 *     (mode='discovery', race-proofed by a partial unique index on
 *     (user_id, company_id)) → actor C run with a completion webhook.
 *   ingest — webhook callback (dispatched from ingestScrapeRun by mode):
 *     dedupe short profiles against contacts/tombstones/known candidates,
 *     upsert discovery_candidates. Dismiss is sticky.
 *
 * Ground truth on the actor's Short-mode items (live probe, 2026-07-10):
 * linkedinUrl is an INTERNAL member-id URL (/in/ACwAA…), there is NO
 * publicIdentifier and NO headline field — `summary` plays the headline
 * role, the photo is `pictureUrl`, and the current role lives in
 * `currentPositions[]`. URL dedupe therefore can't catch contacts stored
 * under vanity URLs, so a name-at-company heuristic backs it up.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { canonicalizeLinkedinUrl, extractPublicIdentifier } from "@/lib/linkedin-url";
import type { PeopleRecord } from "@/lib/scrape-mapper";
import {
  DISCOVERY_COMPANIES_PER_RUN,
  DISCOVERY_MIN_AGE_DAYS,
  DISCOVERY_PAGE_COST_USD,
  DISCOVERY_SOFT_CAP_USD,
  MONTHLY_SCRAPE_CAP_USD,
  PROFILE_SEARCH_ACTOR,
  ScrapeMode,
  ScrapeRunStatus,
  ScrapeTrigger,
} from "@/lib/constants";
import { getAppBaseUrl, getDatasetItems, getRun, isApifyConfigured, startProfileSearchRun } from "./client";
import { getDiscoverySpendUsd, getMonthlySpendUsd } from "./spend";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

/** One actor-C Short-mode dataset item (shape verified by live probe). */
export interface ApifyDiscoveryItem {
  id?: string | null;
  linkedinUrl?: string | null; // internal member-id URL in practice
  firstName?: string | null;
  lastName?: string | null;
  summary?: string | null; // headline-equivalent
  pictureUrl?: string | null;
  location?: { linkedinText?: string | null } | string | null;
  currentPositions?: Array<{
    title?: string | null;
    companyName?: string | null;
    companyId?: string | number | null;
    companyLinkedinUrl?: string | null;
    startedOn?: { month?: number | string | null; year?: number | string | null } | null;
    current?: boolean | null;
  }> | null;
  [key: string]: unknown;
}

export interface DiscoveryCompany {
  companyId: number;
  name: string;
  linkedinUrl: string;
  linkedinCompanyId: string | null;
  lastDiscoveryAt: string | null;
  priorityScore: number | null;
}

export type DiscoveryTriggerResult =
  | { status: "started"; companies: number }
  | { status: "no_companies" }
  | { status: "cap_reached"; spendUsd: number }
  | { status: "disabled" }
  | { status: "disabled_by_admin" };

function killSwitchOn(): boolean {
  return process.env.APIFY_SCRAPE_DISABLED === "true";
}

/**
 * Eligible companies for this cycle: targeted, LinkedIn-addressable, not
 * queried within DISCOVERY_MIN_AGE_DAYS, no discovery run in flight. Stalest
 * first (NULLS first), then priority. A company can hold several scoped
 * target rows (company-wide + offices) — deduped to one entry.
 */
export async function selectDiscoveryCompanies(
  service: ServiceClient,
  userId: string,
  limit: number = DISCOVERY_COMPANIES_PER_RUN,
): Promise<DiscoveryCompany[]> {
  const { data: pendingRuns } = await service
    .from("scrape_runs")
    .select("company_id")
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending)
    .eq("mode", ScrapeMode.Discovery);
  const inFlight = new Set(
    ((pendingRuns as { company_id: number | null }[] | null) ?? [])
      .map((r) => r.company_id)
      .filter((id): id is number => id != null),
  );

  const { data: rows } = await service
    .from("target_companies")
    .select("company_id, last_discovery_at, priority_score, companies!inner(id, name, linkedin_url, linkedin_company_id)")
    .eq("user_id", userId)
    .eq("is_targeted", true)
    .not("companies.linkedin_url", "is", null);

  type TargetRow = {
    company_id: number;
    last_discovery_at: string | null;
    priority_score: number | null;
    companies:
      | { id: number; name: string; linkedin_url: string | null; linkedin_company_id: string | null }
      | Array<{ id: number; name: string; linkedin_url: string | null; linkedin_company_id: string | null }>
      | null;
  };

  // Dedupe scoped rows to one per company: keep the freshest last_discovery_at
  // (any scoped row's stamp counts — they're stamped together) and the highest
  // priority_score.
  const byCompany = new Map<number, DiscoveryCompany>();
  for (const row of ((rows as TargetRow[] | null) ?? [])) {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
    if (!company?.linkedin_url) continue;
    const prev = byCompany.get(row.company_id);
    if (!prev) {
      byCompany.set(row.company_id, {
        companyId: row.company_id,
        name: company.name,
        linkedinUrl: company.linkedin_url,
        linkedinCompanyId: company.linkedin_company_id,
        lastDiscoveryAt: row.last_discovery_at,
        priorityScore: row.priority_score,
      });
    } else {
      if (row.last_discovery_at && (!prev.lastDiscoveryAt || row.last_discovery_at > prev.lastDiscoveryAt)) {
        prev.lastDiscoveryAt = row.last_discovery_at;
      }
      if (row.priority_score != null && (prev.priorityScore == null || row.priority_score > prev.priorityScore)) {
        prev.priorityScore = row.priority_score;
      }
    }
  }

  const minAgeCutoff = Date.now() - DISCOVERY_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  return [...byCompany.values()]
    .filter((c) => !inFlight.has(c.companyId))
    .filter((c) => !c.lastDiscoveryAt || new Date(c.lastDiscoveryAt).getTime() < minAgeCutoff)
    .sort((a, b) => {
      const aTs = a.lastDiscoveryAt ? new Date(a.lastDiscoveryAt).getTime() : -Infinity;
      const bTs = b.lastDiscoveryAt ? new Date(b.lastDiscoveryAt).getTime() : -Infinity;
      if (aTs !== bTs) return aTs - bTs; // stalest (or never) first
      return (b.priorityScore ?? -Infinity) - (a.priorityScore ?? -Infinity);
    })
    .slice(0, limit);
}

/**
 * Start this cycle's discovery runs for a user. Each company is independent:
 * a failed start marks its ledger row failed and moves on. last_discovery_at
 * is stamped at trigger (not ingest) so a failed run can't cause a same-week
 * re-spend; the 24h sweep keeps the ledger honest.
 */
export async function triggerDiscoveryBatch(userId: string): Promise<DiscoveryTriggerResult> {
  if (killSwitchOn() || !isApifyConfigured()) return { status: "disabled" };
  const service = createSupabaseServiceClient();

  // Re-check the admin switch (fail closed) so a future non-cron caller can't
  // bypass it — the cron's user selection is convenience, not the gate.
  const { data: userRow, error: userErr } = await service
    .from("users")
    .select("discovery_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (userErr || !userRow) {
    if (userErr) console.error(`[discovery] controls read failed for ${userId}: ${userErr.message}`);
    return { status: "disabled_by_admin" };
  }
  if (!(userRow as { discovery_enabled: boolean }).discovery_enabled) return { status: "disabled_by_admin" };

  const companies = await selectDiscoveryCompanies(service, userId);
  if (companies.length === 0) return { status: "no_companies" };

  // Both caps fail closed. Counters advance per started run so one batch
  // can't overshoot on stale reads.
  let discoverySpend = await getDiscoverySpendUsd(userId);
  let totalSpend = await getMonthlySpendUsd(userId);
  let started = 0;

  for (const company of companies) {
    if (
      discoverySpend + DISCOVERY_PAGE_COST_USD > DISCOVERY_SOFT_CAP_USD ||
      totalSpend + DISCOVERY_PAGE_COST_USD > MONTHLY_SCRAPE_CAP_USD
    ) {
      return started > 0 ? { status: "started", companies: started } : { status: "cap_reached", spendUsd: totalSpend };
    }

    // Atomic in-flight guard: the partial unique index rejects a second
    // pending discovery row for the same company (23505 = already running).
    const { data: runRow, error: insertErr } = await service
      .from("scrape_runs")
      .insert({
        user_id: userId,
        actor: PROFILE_SEARCH_ACTOR,
        mode: ScrapeMode.Discovery,
        trigger: ScrapeTrigger.Discovery,
        company_id: company.companyId,
      })
      .select("id")
      .single();
    if (insertErr) {
      if (insertErr.code === "23505") continue;
      throw new Error(`Failed to record discovery run: ${insertErr.message}`);
    }
    const scrapeRunId = (runRow as { id: number }).id;

    try {
      // Secret rides in a webhook header (CAR-140 / F26), not the callback URL.
      const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?run=${scrapeRunId}`;
      const run = await startProfileSearchRun({
        companyLinkedinUrl: company.linkedinUrl,
        maxTotalChargeUsd: DISCOVERY_PAGE_COST_USD * 1.5, // one page + margin
        callbackUrl,
      });
      const { error: updateErr } = await service.from("scrape_runs").update({ apify_run_id: run.id }).eq("id", scrapeRunId);
      if (updateErr) console.error(`[discovery] apify_run_id write failed for run ${scrapeRunId}:`, updateErr);

      // Stamp every scoped target row for this company together.
      await service
        .from("target_companies")
        .update({ last_discovery_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("company_id", company.companyId);

      started += 1;
      discoverySpend += DISCOVERY_PAGE_COST_USD;
      totalSpend += DISCOVERY_PAGE_COST_USD;
    } catch (err) {
      // One bad company must not block the rest of the batch.
      await service
        .from("scrape_runs")
        .update({
          status: ScrapeRunStatus.Failed,
          error: err instanceof Error ? err.message : "start failed",
          finished_at: new Date().toISOString(),
        })
        .eq("id", scrapeRunId);
      console.error(`[discovery] run start failed for company ${company.companyId}:`, err);
    }
  }

  return started > 0 ? { status: "started", companies: started } : { status: "no_companies" };
}

// ── Ingest ──────────────────────────────────────────────────────────────

export interface DiscoveryPartitionContext {
  /** Canonical linkedin_urls of the user's existing contacts (any company). */
  existingContactUrls: Set<string>;
  /** Canonical URLs in suppressed_imports (deletion tombstones). */
  suppressedUrls: Set<string>;
  /**
   * Normalized names of contacts employed at the searched company — backs up
   * URL dedupe, which internal member-id URLs defeat for vanity-URL contacts.
   */
  contactNamesAtCompany: Set<string>;
  companyLinkedinId: string | null;
}

export interface DiscoveryCandidateDraft {
  linkedinUrl: string;
  publicIdentifier: string | null;
  name: string;
  headline: string | null;
  location: string | null;
  photoUrl: string | null;
  position: string | null;
  raw: ApifyDiscoveryItem;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function itemLocation(item: ApifyDiscoveryItem): string | null {
  if (typeof item.location === "string") return item.location.trim() || null;
  return item.location?.linkedinText?.trim() || null;
}

/** The current position at the searched company, else the first one. */
function itemPosition(item: ApifyDiscoveryItem, companyLinkedinId: string | null) {
  const positions = item.currentPositions ?? [];
  if (companyLinkedinId) {
    const match = positions.find((p) => p.companyId != null && String(p.companyId) === companyLinkedinId);
    if (match) return match;
  }
  return positions[0] ?? null;
}

/**
 * Pure dedupe/normalize step: raw actor items → candidate drafts. Drops
 * items with no usable URL or name, existing contacts (URL match OR
 * name-at-company match), and tombstoned URLs. Already-known candidates are
 * NOT dropped here — the ingest upsert bumps last_seen_at without touching
 * status (sticky dismiss).
 */
export function partitionDiscoveryItems(
  items: ApifyDiscoveryItem[],
  ctx: DiscoveryPartitionContext,
): { drafts: DiscoveryCandidateDraft[]; dropped: { invalid: number; existing: number; suppressed: number } } {
  const drafts: DiscoveryCandidateDraft[] = [];
  const dropped = { invalid: 0, existing: 0, suppressed: 0 };
  const seen = new Set<string>();

  for (const item of items) {
    const url = canonicalizeLinkedinUrl(item.linkedinUrl);
    const name = `${item.firstName ?? ""} ${item.lastName ?? ""}`.trim();
    if (!url || !name || seen.has(url)) {
      dropped.invalid += 1;
      continue;
    }
    seen.add(url);

    if (ctx.suppressedUrls.has(url)) {
      dropped.suppressed += 1;
      continue;
    }
    if (ctx.existingContactUrls.has(url) || ctx.contactNamesAtCompany.has(normalizeName(name))) {
      dropped.existing += 1;
      continue;
    }

    const position = itemPosition(item, ctx.companyLinkedinId);
    drafts.push({
      linkedinUrl: url,
      publicIdentifier: extractPublicIdentifier(url),
      name,
      headline: item.summary?.trim() || null,
      location: itemLocation(item),
      photoUrl: item.pictureUrl?.trim() || null,
      position: position?.title?.trim() || null,
      raw: item,
    });
  }

  return { drafts, dropped };
}

/**
 * Ingest a finished discovery run. Dispatched from ingestScrapeRun (which
 * owns the row lookup + atomic ingest claim) when run.mode === 'discovery'.
 */
export async function ingestDiscoveryRun(
  service: ServiceClient,
  run: { id: number; user_id: string; company_id: number | null },
  apifyRunId: string,
  now: string,
): Promise<void> {
  let costUsd: number | null = null;

  try {
    const apifyRun = await getRun(apifyRunId);
    const cost = Number(apifyRun.usageTotalUsd ?? 0);
    costUsd = cost;

    if (apifyRun.status !== "SUCCEEDED") {
      await markTerminal(service, run.id, ScrapeRunStatus.Failed, cost, now, `Apify run ${apifyRun.status}`);
      return;
    }
    if (run.company_id == null) {
      await markTerminal(service, run.id, ScrapeRunStatus.Failed, cost, now, "Discovery run has no company_id");
      return;
    }

    const items = (await getDatasetItems(apifyRun.defaultDatasetId)) as unknown as ApifyDiscoveryItem[];
    if (items.length === 0) {
      // A page can legitimately be empty (no recent PM hires this cycle).
      await markTerminal(service, run.id, ScrapeRunStatus.Succeeded, cost, now, null);
      return;
    }

    const ctx = await loadPartitionContext(service, run.user_id, run.company_id, items);
    const { drafts, dropped } = partitionDiscoveryItems(items, ctx);
    if (dropped.existing || dropped.suppressed) {
      console.log(
        `[discovery] run ${run.id}: ${drafts.length} candidates (${dropped.existing} known, ${dropped.suppressed} suppressed, ${dropped.invalid} invalid)`,
      );
    }

    await upsertCandidates(service, run.user_id, run.company_id, drafts, now);
    await markTerminal(service, run.id, ScrapeRunStatus.Succeeded, cost, now, null);
  } catch (err) {
    // Never leave the row pending, and never ledger a charged run at $0.
    await markTerminal(
      service,
      run.id,
      ScrapeRunStatus.Failed,
      costUsd ?? DISCOVERY_PAGE_COST_USD,
      now,
      err instanceof Error ? err.message : "discovery ingest failed",
    );
  }
}

async function loadPartitionContext(
  service: ServiceClient,
  userId: string,
  companyId: number,
  items: ApifyDiscoveryItem[],
): Promise<DiscoveryPartitionContext> {
  const urls = items
    .map((i) => canonicalizeLinkedinUrl(i.linkedinUrl))
    .filter((u): u is string => Boolean(u));

  const [{ data: contactRows }, { data: suppressedRows }, { data: atCompanyRows }, { data: companyRow }] =
    await Promise.all([
      urls.length
        ? service.from("contacts").select("linkedin_url").eq("user_id", userId).in("linkedin_url", urls)
        : Promise.resolve({ data: [] as { linkedin_url: string | null }[] }),
      service.from("suppressed_imports").select("linkedin_url").eq("user_id", userId),
      service
        .from("contacts")
        .select("name, contact_companies!inner(company_id)")
        .eq("user_id", userId)
        .eq("contact_companies.company_id", companyId),
      service.from("companies").select("linkedin_company_id").eq("id", companyId).maybeSingle(),
    ]);

  return {
    existingContactUrls: new Set(
      ((contactRows as { linkedin_url: string | null }[] | null) ?? [])
        .map((r) => r.linkedin_url)
        .filter((u): u is string => Boolean(u)),
    ),
    suppressedUrls: new Set(
      ((suppressedRows as { linkedin_url: string }[] | null) ?? []).map((r) => r.linkedin_url),
    ),
    contactNamesAtCompany: new Set(
      ((atCompanyRows as { name: string | null }[] | null) ?? [])
        .map((r) => (r.name ? normalizeName(r.name) : null))
        .filter((n): n is string => Boolean(n)),
    ),
    companyLinkedinId: (companyRow as { linkedin_company_id: string | null } | null)?.linkedin_company_id ?? null,
  };
}

/**
 * New candidates insert as status='new'; re-discovered ones that are still
 * 'new' refresh observed fields + last_seen_at. status is NEVER touched (sticky
 * dismiss, and an 'added' candidate stays added), and re-discovery NEVER
 * repopulates the payload of an added/dismissed row — its profile data was
 * redacted at the transition (CAR-135 / R4.8), so the `status = 'new'` guard on
 * the refresh keeps it redacted.
 */
async function upsertCandidates(
  service: ServiceClient,
  userId: string,
  companyId: number,
  drafts: DiscoveryCandidateDraft[],
  now: string,
): Promise<void> {
  if (drafts.length === 0) return;

  const { data: existingRows, error: existingErr } = await service
    .from("discovery_candidates")
    .select("linkedin_url")
    .eq("user_id", userId)
    .in("linkedin_url", drafts.map((d) => d.linkedinUrl));
  if (existingErr) throw new Error(`candidate lookup failed: ${existingErr.message}`);
  const known = new Set(
    ((existingRows as { linkedin_url: string }[] | null) ?? []).map((r) => r.linkedin_url),
  );

  const inserts = drafts
    .filter((d) => !known.has(d.linkedinUrl))
    .map((d) => ({
      user_id: userId,
      company_id: companyId,
      linkedin_url: d.linkedinUrl,
      public_identifier: d.publicIdentifier,
      name: d.name,
      headline: d.headline,
      location: d.location,
      photo_url: d.photoUrl,
      position: d.position,
      raw: d.raw as unknown as Record<string, unknown>,
      first_seen_at: now,
      last_seen_at: now,
    }));
  if (inserts.length > 0) {
    // Concurrent ingest of the same person from two companies' runs can race
    // the lookup above — ignoreDuplicates keeps the insert idempotent.
    const { error } = await service
      .from("discovery_candidates")
      .upsert(inserts, { onConflict: "user_id,linkedin_url", ignoreDuplicates: true });
    if (error) throw new Error(`candidate insert failed: ${error.message}`);
  }

  for (const d of drafts.filter((d) => known.has(d.linkedinUrl))) {
    const { error } = await service
      .from("discovery_candidates")
      .update({
        name: d.name,
        headline: d.headline,
        location: d.location,
        photo_url: d.photoUrl,
        position: d.position,
        raw: d.raw as unknown as Record<string, unknown>,
        last_seen_at: now,
      })
      .eq("user_id", userId)
      .eq("linkedin_url", d.linkedinUrl)
      // Only 'new' rows carry a live payload; added/dismissed rows were redacted
      // at the transition and must not be repopulated (CAR-135 / R4.8).
      .eq("status", "new");
    if (error) console.error(`[discovery] candidate refresh failed for ${d.linkedinUrl}:`, error);
  }
}

async function markTerminal(
  service: ServiceClient,
  id: number,
  status: string,
  cost: number,
  now: string,
  error: string | null,
): Promise<void> {
  await service.from("scrape_runs").update({ status, cost_usd: cost, error, finished_at: now }).eq("id", id);
}

// ── Add-as-contact record (plan 41 §5.3) ────────────────────────────────

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startedOnToActorDate(
  startedOn: { month?: number | string | null; year?: number | string | null } | null | undefined,
): { month?: string | null; year?: number | string | null } | null {
  if (!startedOn?.year) return null;
  const monthNum = startedOn.month != null ? Number(startedOn.month) : NaN;
  const month = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12 ? MONTH_NAMES[monthNum - 1] : null;
  return { month, year: startedOn.year };
}

/**
 * Build the schema-v1 people-record that turns a candidate into a contact
 * via importPeopleChunk. Mapper contract (verified in the plan audit):
 * identity.name is a single string; employment is read ONLY from
 * raw_profiles[].data.experience; threading the known company's LinkedIn
 * identity makes findOrCreateCompany hit the existing row instead of
 * inserting a name-ilike duplicate; selected_contact SELECTED → a clean
 * 'prospect'; found_by_searches → import_source 'apify:discovery'.
 */
export function buildCandidatePeopleRecord(
  candidate: {
    name: string;
    linkedin_url: string;
    headline: string | null;
    location: string | null;
    photo_url: string | null;
    position: string | null;
    raw: unknown;
  },
  company: { name: string; linkedin_url: string | null; linkedin_company_id: string | null },
): PeopleRecord {
  const raw = (candidate.raw ?? {}) as ApifyDiscoveryItem;
  const rawPosition = itemPosition(raw, company.linkedin_company_id);

  return {
    schema_version: "1",
    identity: {
      name: candidate.name,
      linkedin_url: candidate.linkedin_url,
      location: candidate.location,
    },
    pipeline: {
      selected_contact: "SELECTED",
      found_by_searches: "discovery",
    },
    crm: {},
    raw_profiles: [
      {
        source: "discovery",
        data: {
          linkedinUrl: candidate.linkedin_url,
          headline: candidate.headline,
          photo: candidate.photo_url,
          location: { linkedinText: candidate.location },
          experience: [
            {
              position: candidate.position ?? rawPosition?.title ?? null,
              companyName: company.name,
              companyId: company.linkedin_company_id,
              companyLinkedinUrl: company.linkedin_url,
              startDate: startedOnToActorDate(rawPosition?.startedOn),
              // no endDate → mapper treats the role as current
            },
          ],
        },
      },
    ],
  };
}

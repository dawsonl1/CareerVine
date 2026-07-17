/**
 * Scrape orchestration (plan 29 §7.2): trigger and ingest, split so no route
 * ever waits on a multi-minute Apify run.
 *
 *   trigger — validate (kill-switch, config, debounce, monthly cap) → record a
 *     pending scrape_runs row (an atomic partial-unique index makes "one
 *     in-flight run per contact" race-proof) → start the run with a completion
 *     webhook that carries the scrape_runs id. Returns immediately.
 *   ingest — the webhook callback: correlate by scrape_runs id, load the run +
 *     dataset, rescrape-merge each item, reconcile per-contact failure
 *     tracking, and stamp the run's cost. Any error marks the run terminal so
 *     a stuck 'pending' row can never brick the contact.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { importPeopleChunk, type PersonImportInput, type RescrapeDiffCapture } from "@/lib/bulk-import";
import { buildSnapshot, computeDiff, type ScrapeSnapshot } from "@/lib/change-events/diff-engine";
import {
  CADENCE_SOFT_CAP_USD,
  ChangeEventType,
  MONTHLY_SCRAPE_CAP_USD,
  PROFILE_SCRAPER_ACTOR,
  SCRAPE_DEBOUNCE_DAYS,
  SCRAPE_UNIT_COST_USD,
  ScrapeMode,
  ScrapeRunStatus,
} from "@/lib/constants";
import {
  startProfileScrapeRun,
  getRun,
  getDatasetItems,
  getAppBaseUrl,
  isApifyConfigured,
  type ApifyProfileItem,
} from "./client";
import { actorItemToPeopleRecord } from "./rescrape-wrapper";
import { getApifyControls } from "./account-controls";
import { ingestDiscoveryRun } from "./discovery";
import { estimateRunCostUsd, getDiscoverySpendUsd, getMonthlySpendUsd } from "./spend";

// Spend accounting moved to ./spend (plan 41) — re-exported so existing
// callers (resolver, routes, tests) keep their import path.
export { getMonthlySpendUsd } from "./spend";

type Mode = "profile" | "email";
type Trigger = "manual" | "enrich_on_save" | "cadence";
type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export type TriggerResult =
  | { status: "started"; scrapeRunId: number; apifyRunId: string }
  | { status: "pending"; scrapeRunId?: number }
  | { status: "debounced"; lastScrapedAt: string }
  | { status: "no_url" }
  | { status: "cap_reached"; spendUsd: number }
  | { status: "disabled" }
  | { status: "disabled_by_admin" };

function killSwitchOn(): boolean {
  return process.env.APIFY_SCRAPE_DISABLED === "true";
}

/**
 * Trigger a scrape for a single contact. Race-proof: a partial unique index on
 * (user_id, single_contact_id) WHERE status='pending' means a concurrent
 * duplicate insert fails and returns { status: "pending" } — never a second
 * paid run.
 */
export async function triggerContactScrape(opts: {
  userId: string;
  contactId: number;
  mode: Mode;
  trigger: Trigger;
}): Promise<TriggerResult> {
  const { userId, contactId, mode, trigger } = opts;
  if (killSwitchOn() || !isApifyConfigured()) return { status: "disabled" };

  const service = createSupabaseServiceClient();

  // Per-account admin kill switch (plan 36) — gates every paid trigger path
  // that funnels through here (manual, enrich-on-save, email follow-ups).
  const controls = await getApifyControls(service, userId);
  if (!controls.enrichmentEnabled) return { status: "disabled_by_admin" };

  const { data: contact } = await service
    .from("contacts")
    .select("id, linkedin_url, last_scraped_at, scrape_failed_at")
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

  const url = canonicalizeLinkedinUrl((contact as { linkedin_url: string | null } | null)?.linkedin_url);
  if (!url) return { status: "no_url" };

  // Debounce non-cadence re-scrapes. The debounce is mode-aware:
  //  - profile mode keys off last_scraped_at;
  //  - email mode keys off last_scraped_at ONLY if the contact already has an
  //    email (otherwise a profile refresh shouldn't block a first email search),
  //    but a recent failed attempt still debounces so a private profile can't be
  //    re-charged on every click.
  const c = contact as { last_scraped_at: string | null; scrape_failed_at: string | null };
  if (trigger !== "cadence") {
    const windowMs = SCRAPE_DEBOUNCE_DAYS * 24 * 60 * 60 * 1000;
    const fresh = (ts: string | null) => ts != null && Date.now() - new Date(ts).getTime() < windowMs;
    let debounceTs: string | null = null;
    if (mode === ScrapeMode.Email) {
      if (await contactHasEmail(service, contactId)) debounceTs = c.last_scraped_at;
      else if (fresh(c.scrape_failed_at)) debounceTs = c.scrape_failed_at;
    } else {
      debounceTs = c.last_scraped_at;
    }
    if (fresh(debounceTs)) return { status: "debounced", lastScrapedAt: debounceTs! };
  }

  // Monthly hard cap (fails closed on query error — see getMonthlySpendUsd).
  const spend = await getMonthlySpendUsd(userId);
  const unit = SCRAPE_UNIT_COST_USD[mode];
  if (spend + unit > MONTHLY_SCRAPE_CAP_USD) return { status: "cap_reached", spendUsd: spend };

  // Atomic in-flight guard: the partial unique index rejects a second pending
  // row for the same contact. A 23505 conflict means a run is already in flight.
  const { data: runRow, error: insertErr } = await service
    .from("scrape_runs")
    .insert({ user_id: userId, actor: PROFILE_SCRAPER_ACTOR, mode, trigger, contact_ids: [contactId], single_contact_id: contactId })
    .select("id")
    .single();
  if (insertErr) {
    if (insertErr.code === "23505") return { status: "pending" };
    throw new Error(`Failed to record scrape run: ${insertErr.message}`);
  }
  const scrapeRunId = (runRow as { id: number }).id;

  try {
    // The scrape_runs id rides in the callback URL so ingest correlates by it
    // directly — no dependency on the apify_run_id write winning a race with a
    // fast run's completion webhook. The webhook secret travels in a header, not
    // the URL (CAR-140 / F26) — see terminalWebhookParam in client.ts.
    const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?run=${scrapeRunId}`;
    const run = await startProfileScrapeRun({
      urls: [url],
      mode,
      maxTotalChargeUsd: Math.max(0.05, unit * 3),
      callbackUrl,
    });
    const { error: updateErr } = await service.from("scrape_runs").update({ apify_run_id: run.id }).eq("id", scrapeRunId);
    if (updateErr) {
      // Non-fatal: ingest correlates by scrape_runs id (from the callback URL),
      // not apify_run_id. Log loudly so a broken write is visible.
      console.error(`[scrape] apify_run_id write failed for run ${scrapeRunId}:`, updateErr);
    }
    return { status: "started", scrapeRunId, apifyRunId: run.id };
  } catch (err) {
    await service
      .from("scrape_runs")
      .update({ status: ScrapeRunStatus.Failed, error: err instanceof Error ? err.message : "start failed", finished_at: new Date().toISOString() })
      .eq("id", scrapeRunId);
    throw err;
  }
}

/**
 * Start one batched cadence run for a user (plan 29 §7.3). The caller has
 * already selected eligible contacts; this enforces the spend cap (trimming
 * the batch to the remaining budget), records the ledger row, and starts the
 * run with a per-batch charge cap. Returns the number of contacts actually
 * covered (0 = nothing started).
 */
export async function triggerBatchScrape(
  userId: string,
  contacts: Array<{ contactId: number; url: string }>,
  mode: Mode = ScrapeMode.Profile,
): Promise<number> {
  if (contacts.length === 0 || killSwitchOn() || !isApifyConfigured()) return 0;
  const service = createSupabaseServiceClient();

  // Per-account admin kill switch (plan 36). The cron also pre-filters, but
  // this is the authoritative gate for any future batch caller.
  const controls = await getApifyControls(service, userId);
  if (!controls.enrichmentEnabled) return 0;

  // Trim the batch to the remaining AUTOMATIC budget (fail-closed on error).
  // Cadence stops at the soft cap so manual actions keep the headroom between
  // soft and hard cap (plan 29 §9.3 — the Settings copy promises this order).
  // Discovery spend is subtracted from the soft-cap math (plan 41 §3.5): the
  // weekly search has its own soft lane and must not throttle the drip. The
  // HARD cap still counts every dollar, so the total can never overshoot.
  const spend = await getMonthlySpendUsd(userId);
  const discoverySpend = await getDiscoverySpendUsd(userId);
  const unit = SCRAPE_UNIT_COST_USD[mode];
  const affordable = Math.min(
    Math.floor((CADENCE_SOFT_CAP_USD - (spend - discoverySpend)) / unit),
    Math.floor((MONTHLY_SCRAPE_CAP_USD - spend) / unit),
  );
  if (affordable <= 0) return 0;
  const batch = contacts.slice(0, affordable);

  const { data: runRow, error: insertErr } = await service
    .from("scrape_runs")
    .insert({
      user_id: userId,
      actor: PROFILE_SCRAPER_ACTOR,
      mode,
      trigger: "cadence",
      contact_ids: batch.map((c) => c.contactId),
      single_contact_id: null, // batch runs aren't covered by the per-contact guard
    })
    .select("id")
    .single();
  if (insertErr || !runRow) throw new Error(`Failed to record cadence run: ${insertErr?.message}`);
  const scrapeRunId = (runRow as { id: number }).id;

  try {
    // Secret rides in a webhook header (CAR-140 / F26), not the callback URL.
    const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?run=${scrapeRunId}`;
    const run = await startProfileScrapeRun({
      urls: batch.map((c) => c.url),
      mode,
      // Sized to the batch (deep-review F7): a fixed cap would abort a
      // legitimate multi-item run mid-way.
      maxTotalChargeUsd: Math.max(0.05, batch.length * unit * 2),
      callbackUrl,
    });
    const { error: updateErr } = await service.from("scrape_runs").update({ apify_run_id: run.id }).eq("id", scrapeRunId);
    if (updateErr) console.error(`[scrape] apify_run_id write failed for cadence run ${scrapeRunId}:`, updateErr);
    return batch.length;
  } catch (err) {
    await service
      .from("scrape_runs")
      .update({ status: ScrapeRunStatus.Failed, error: err instanceof Error ? err.message : "start failed", finished_at: new Date().toISOString() })
      .eq("id", scrapeRunId);
    throw err;
  }
}

/**
 * Sweep runs stuck 'pending' longer than 24h (missed/lost webhooks) to
 * 'timed_out' so they stop blocking contacts and reserving budget. Their
 * contacts simply become eligible for the next cadence pass.
 */
export async function sweepStuckRuns(): Promise<number> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // A run pending >24h almost certainly ran and CHARGED at Apify — only its
  // completion webhook was lost. Record an estimated cost so the monthly cap
  // stays a real ceiling; otherwise a systematically-broken webhook would burn
  // Apify credit daily while the ledger (which the cap sums) shows $0.
  const { data: stuck } = await service
    .from("scrape_runs")
    .select("id, mode, contact_ids")
    .eq("status", ScrapeRunStatus.Pending)
    .lt("created_at", cutoff);
  const rows = (stuck as { id: number; mode: string; contact_ids: number[] }[] | null) ?? [];

  for (const run of rows) {
    const estimated = estimateRunCostUsd(run.mode, run.contact_ids?.length ?? 1, SCRAPE_UNIT_COST_USD.profile);
    await service
      .from("scrape_runs")
      .update({ status: ScrapeRunStatus.TimedOut, cost_usd: estimated, error: "No webhook within 24h (estimated cost)", finished_at: now })
      .eq("id", run.id)
      .eq("status", ScrapeRunStatus.Pending);
  }
  return rows.length;
}

/**
 * Auto-enrich after an extension save (plan 29 §6.5, Dawson's decision §9.1).
 * Picks the mode by value: email search ($0.01) when the contact has no email
 * — one run fills photo + real employment + verified email — else a plain
 * profile refresh ($0.004). Never throws: an enrich failure must not fail the
 * save it rides on.
 */
export async function triggerEnrichOnSave(userId: string, contactId: number): Promise<TriggerResult> {
  try {
    const service = createSupabaseServiceClient();
    const hasEmail = await contactHasEmail(service, contactId);
    return await triggerContactScrape({
      userId,
      contactId,
      mode: hasEmail ? ScrapeMode.Profile : ScrapeMode.Email,
      trigger: "enrich_on_save",
    });
  } catch (err) {
    console.error(`[scrape] enrich-on-save failed for contact ${contactId}:`, err);
    return { status: "disabled" };
  }
}

/**
 * Does the contact have a *usable* (non-bounced) email? Used consistently by
 * enrich mode-selection, the email-mode debounce, and the company-change
 * follow-up — a contact whose only address has bounced counts as "no email"
 * so an email search is chosen and NOT debounced away (review fix: the three
 * checks previously disagreed, silently blocking the follow-up for exactly
 * the bounced-only contacts it targets).
 */
async function contactHasEmail(service: ServiceClient, contactId: number): Promise<boolean> {
  const { count } = await service
    .from("contact_emails")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .is("bounced_at", null);
  return (count ?? 0) > 0;
}

/**
 * Ingest a finished Apify run (called by the webhook callback). Correlated by
 * scrape_runs id when available, else by apify_run_id. Idempotent (a terminal
 * row is a no-op) and self-healing (any error marks the row terminal so a stuck
 * 'pending' can never permanently block the contact).
 */
export async function ingestScrapeRun(opts: { scrapeRunId?: number; apifyRunId: string }): Promise<void> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();

  const query = service
    .from("scrape_runs")
    .select("id, user_id, mode, contact_ids, company_id, status")
    .limit(1);
  const { data: rows, error: fetchErr } = opts.scrapeRunId != null
    ? await query.eq("id", opts.scrapeRunId)
    : await query.eq("apify_run_id", opts.apifyRunId);
  // A transient DB error is NOT "unknown run" — surface it so the callback
  // route can answer non-2xx and Apify's webhook retry redelivers in minutes
  // instead of the data waiting on the 24h sweep.
  if (fetchErr) throw new Error(`run lookup failed: ${fetchErr.message}`);
  const runRow = (rows as Array<{ id: number; user_id: string; mode: string; contact_ids: number[]; company_id: number | null; status: string }> | null)?.[0];
  if (!runRow) return; // unknown run — ignore
  if (runRow.status !== ScrapeRunStatus.Pending) return; // already ingested

  // Atomic ingest claim: Apify may deliver the same webhook more than once,
  // and two overlapping ingests would double-apply the merge (permanent
  // duplicate employment rows — no unique index catches them). CAS via count
  // (never .select(): rule 17 — PostgREST re-applies filters to RETURNING).
  // A stale claim (crashed ingest) is re-claimable after 10 minutes, and the
  // row stays 'pending' so the 24h sweep still covers total loss.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count: claimed, error: claimErr } = await service
    .from("scrape_runs")
    .update({ ingest_claimed_at: now }, { count: "exact" })
    .eq("id", runRow.id)
    .eq("status", ScrapeRunStatus.Pending)
    .or(`ingest_claimed_at.is.null,ingest_claimed_at.lt.${staleBefore}`);
  if (claimErr) throw new Error(`ingest claim failed: ${claimErr.message}`);
  if (!claimed) return; // another delivery holds a live claim

  // Discovery runs produce candidates, not contact merges — separate ingest
  // path sharing this lookup + claim (plan 41 §3.4).
  if (runRow.mode === ScrapeMode.Discovery) {
    await ingestDiscoveryRun(service, runRow, opts.apifyRunId, now);
    return;
  }

  const contactIds = runRow.contact_ids ?? [];
  // Hoisted so the catch can ledger the REAL cost of a charged-but-unprocessed
  // run instead of $0 (the sweep never revisits terminal rows).
  let costUsd: number | null = null;

  try {
    const run = await getRun(opts.apifyRunId);
    const cost = Number(run.usageTotalUsd ?? 0);
    costUsd = cost;

    if (run.status !== "SUCCEEDED") {
      await markRunTerminal(service, runRow.id, ScrapeRunStatus.Failed, cost, now, `Apify run ${run.status}`);
      await bumpFailures(service, contactIds, now);
      return;
    }

    const items = await getDatasetItems(run.defaultDatasetId);
    if (items.length === 0) {
      // Reachable-but-empty: private/removed profile. Soft failure.
      await markRunTerminal(service, runRow.id, ScrapeRunStatus.Succeeded, cost, now, null);
      await bumpFailures(service, contactIds, now);
      return;
    }

    const inputs: PersonImportInput[] = items.map((item) => ({
      record: actorItemToPeopleRecord(item, { emailSearched: runRow.mode === ScrapeMode.Email }),
    }));
    const captures: RescrapeDiffCapture[] = [];
    const summary = await importPeopleChunk(service, runRow.user_id, inputs, {
      mergePolicy: "rescrape",
      // Single-contact runs identify their target, so the merge can find it
      // even when the item's vanity URL doesn't match a stored internal-id
      // URL (discovery adds, resolver links) — the rescrape patch then fills
      // public_identifier and future runs match normally.
      targetContactId: contactIds.length === 1 ? contactIds[0] : undefined,
      hooks: { onDiffCapture: (c) => captures.push(c) },
    });

    // Only diff contacts whose merge actually SUCCEEDED — a capture is taken
    // before the employment writes, so a person whose merge threw would
    // otherwise emit a change event (and an email follow-up) for data that was
    // never persisted, re-firing every scrape thereafter.
    const mergedUrls = new Set(
      summary.results
        .filter((r) => r.status === "updated" || r.status === "created")
        .map((r) => canonicalizeLinkedinUrl(r.linkedin_url))
        .filter(Boolean) as string[],
    );
    const goodCaptures = captures.filter((c) => mergedUrls.has(c.linkedinUrl));

    // Scrape-diff: emit change events + snapshots. Isolated — a diff failure
    // must never fail an already-merged run. Skipped entirely when the admin
    // turned diff analysis off for this account (plan 36) — data still merged.
    let companyChangeContacts: number[] = [];
    const controls = await getApifyControls(service, runRow.user_id);
    if (controls.diffEnabled) {
      try {
        companyChangeContacts = await processDiffs(service, runRow.user_id, runRow.id, items, goodCaptures, now);
      } catch (err) {
        console.error(`[scrape] diff processing failed for run ${runRow.id}:`, err);
      }
    }

    const { succeeded, failed } = await reconcileContacts(service, contactIds, summary.results);
    await markRunTerminal(service, runRow.id, ScrapeRunStatus.Succeeded, cost, now, null);
    if (succeeded.length) await resetFailures(service, succeeded);
    if (failed.length) await bumpFailures(service, failed, now);

    // Event-driven email search (plan 29 §4): a company change means a new
    // domain — the one moment a previously-failed email search has fresh odds.
    // Runs AFTER the run is terminal so the new trigger isn't blocked as
    // in-flight. Profile-mode runs only (an email run already searched).
    if (runRow.mode !== ScrapeMode.Email && companyChangeContacts.length > 0) {
      await triggerEmailFollowups(service, runRow.user_id, companyChangeContacts);
    }
  } catch (err) {
    // Never leave the row pending — that would block the contact forever. And
    // never ledger a run Apify charged at $0: use the real cost when getRun
    // succeeded, else the sweep's conservative size×unit estimate.
    const ledgered = costUsd ?? estimateRunCostUsd(runRow.mode, contactIds.length, SCRAPE_UNIT_COST_USD.profile);
    await markRunTerminal(service, runRow.id, ScrapeRunStatus.Failed, ledgered, now, err instanceof Error ? err.message : "ingest failed");
    await bumpFailures(service, contactIds, now);
  }
}

/**
 * Correlate merge results back to contacts. For a single-contact run the run
 * itself identifies the contact, so success = "the merge updated a contact" —
 * robust to an internal-id→vanity URL upgrade that would defeat URL matching.
 * Multi-contact runs (future cadence) fall back to canonical-URL correlation.
 */
async function reconcileContacts(
  service: ServiceClient,
  contactIds: number[],
  results: { status: string; linkedin_url: string | null }[],
): Promise<{ succeeded: number[]; failed: number[] }> {
  const merged = results.filter((r) => r.status === "updated" || r.status === "created");

  if (contactIds.length === 1) {
    return merged.length > 0 ? { succeeded: contactIds, failed: [] } : { succeeded: [], failed: contactIds };
  }

  const okUrls = new Set(
    merged.map((r) => canonicalizeLinkedinUrl(r.linkedin_url)).filter(Boolean) as string[],
  );
  const { data: contactRows } = await service.from("contacts").select("id, linkedin_url").in("id", contactIds);
  const succeeded: number[] = [];
  const failed: number[] = [];
  for (const c of (contactRows as { id: number; linkedin_url: string | null }[] | null) ?? []) {
    const cu = canonicalizeLinkedinUrl(c.linkedin_url);
    if (cu && okUrls.has(cu)) succeeded.push(c.id);
    else failed.push(c.id);
  }
  return { succeeded, failed };
}

/**
 * Scrape-diff step (plan 29 §5): for every rescraped contact, diff the fresh
 * scrape against the pre-merge state + latest snapshot, upsert the resulting
 * change events (deduped on (user_id, dedupe_key) so re-detection never
 * duplicates and a dismissal is permanent), and record the new snapshot.
 */
async function processDiffs(
  service: ServiceClient,
  userId: string,
  scrapeRunId: number,
  items: ApifyProfileItem[],
  captures: RescrapeDiffCapture[],
  now: string,
): Promise<number[]> {
  if (captures.length === 0) return [];

  // Correlate raw items back to captures by canonical URL.
  const itemByUrl = new Map<string, ApifyProfileItem>();
  for (const item of items) {
    const url = canonicalizeLinkedinUrl(
      item.linkedinUrl ?? (item.publicIdentifier ? `https://www.linkedin.com/in/${item.publicIdentifier}` : null),
    );
    if (url && !itemByUrl.has(url)) itemByUrl.set(url, item);
  }

  // Latest prior snapshot per contact — via a DISTINCT ON RPC so it can't be
  // truncated by PostgREST's 1000-row select ceiling as snapshot history grows.
  const contactIds = captures.map((c) => c.contactId);
  const { data: snapRows } = await service.rpc("latest_contact_snapshots", { p_contact_ids: contactIds });
  const prevByContact = new Map<number, ScrapeSnapshot>();
  for (const row of (snapRows as { contact_id: number; snapshot: ScrapeSnapshot }[] | null) ?? []) {
    prevByContact.set(row.contact_id, row.snapshot);
  }

  // linkedin_company_id lookup: incoming side rides on the captures; fetch the
  // existing side's companies in one query.
  const existingCompanyIds = new Set<number>();
  const companyLinkedinIds = new Map<number, string | null>();
  for (const c of captures) {
    for (const e of c.incomingEmployment) companyLinkedinIds.set(e.company_id, e.linkedin_company_id);
    for (const e of c.existingEmployment) existingCompanyIds.add(e.company_id);
  }
  const missing = [...existingCompanyIds].filter((id) => !companyLinkedinIds.has(id));
  if (missing.length > 0) {
    const { data: companyRows } = await service
      .from("companies")
      .select("id, linkedin_company_id")
      .in("id", missing);
    for (const row of (companyRows as { id: number; linkedin_company_id: string | null }[] | null) ?? []) {
      companyLinkedinIds.set(row.id, row.linkedin_company_id);
    }
  }

  const eventRows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];

  for (const capture of captures) {
    const item = itemByUrl.get(capture.linkedinUrl);
    if (!item) continue;

    const nextSnapshot = buildSnapshot(item, capture.incomingEmployment);
    const events = computeDiff({
      contactId: capture.contactId,
      contactName: capture.contactName,
      scrapedAt: now,
      existingEmployment: capture.existingEmployment,
      companyLinkedinIds,
      prevSnapshot: prevByContact.get(capture.contactId) ?? null,
      nextSnapshot,
    });

    for (const e of events) {
      eventRows.push({
        user_id: userId,
        contact_id: e.contactId,
        type: e.type,
        tier: e.tier,
        dedupe_key: e.dedupeKey,
        headline: e.headline,
        evidence: e.evidence,
        suggested_title: e.suggestedTitle,
        suggested_description: e.suggestedDescription,
        old_value: e.oldValue,
        new_value: e.newValue,
      });
    }
    snapshotRows.push({
      user_id: userId,
      contact_id: capture.contactId,
      scrape_run_id: scrapeRunId,
      scraped_at: now,
      snapshot: nextSnapshot as unknown as Record<string, unknown>,
    });
  }

  if (eventRows.length > 0) {
    const { error } = await service
      .from("contact_change_events")
      .upsert(eventRows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
    if (error) console.error("[scrape] change-event upsert failed:", error);
  }
  if (snapshotRows.length > 0) {
    const { error } = await service.from("contact_scrape_snapshots").insert(snapshotRows);
    if (error) console.error("[scrape] snapshot insert failed:", error);
  }

  return [...new Set(eventRows.filter((r) => r.type === ChangeEventType.CompanyChange).map((r) => r.contact_id as number))];
}

/**
 * For contacts who just changed companies and have no usable (non-bounced)
 * email, start an email-mode re-scrape. Best-effort per contact — a failure
 * here never affects the completed run.
 */
async function triggerEmailFollowups(service: ServiceClient, userId: string, contactIds: number[]): Promise<void> {
  for (const contactId of contactIds) {
    try {
      const { count } = await service
        .from("contact_emails")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contactId)
        .is("bounced_at", null);
      if ((count ?? 0) > 0) continue;

      const result = await triggerContactScrape({ userId, contactId, mode: ScrapeMode.Email, trigger: "cadence" });
      if (result.status !== "started" && result.status !== "pending") {
        console.warn(`[scrape] email follow-up for contact ${contactId} not started: ${result.status}`);
      }
    } catch (err) {
      console.error(`[scrape] email follow-up failed for contact ${contactId}:`, err);
    }
  }
}

async function markRunTerminal(service: ServiceClient, id: number, status: string, cost: number, now: string, error: string | null) {
  await service
    .from("scrape_runs")
    .update({ status, cost_usd: cost, error, finished_at: now })
    .eq("id", id);
}

async function resetFailures(service: ServiceClient, ids: number[]) {
  await service.from("contacts").update({ scrape_failure_count: 0, scrape_failed_at: null }).in("id", ids);
}

async function bumpFailures(service: ServiceClient, ids: number[], now: string) {
  if (!ids.length) return;
  const { data } = await service.from("contacts").select("id, scrape_failure_count").in("id", ids);
  for (const c of (data as { id: number; scrape_failure_count: number | null }[] | null) ?? []) {
    await service
      .from("contacts")
      .update({ scrape_failure_count: (c.scrape_failure_count ?? 0) + 1, scrape_failed_at: now })
      .eq("id", c.id);
  }
}

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

type Mode = "profile" | "email";
type Trigger = "manual" | "enrich_on_save" | "cadence";
type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export type TriggerResult =
  | { status: "started"; scrapeRunId: number; apifyRunId: string }
  | { status: "pending"; scrapeRunId?: number }
  | { status: "debounced"; lastScrapedAt: string }
  | { status: "no_url" }
  | { status: "cap_reached"; spendUsd: number }
  | { status: "disabled" };

function killSwitchOn(): boolean {
  return process.env.APIFY_SCRAPE_DISABLED === "true";
}

function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Effective month-to-date spend for the cap check: settled cost (server-side
 * SUM, so it can't be truncated by the client's row ceiling) plus a
 * conservative reserve for still-in-flight runs whose cost hasn't landed yet.
 * Throws on query error so the caller fails CLOSED (never treats an error as $0).
 */
export async function getMonthlySpendUsd(userId: string): Promise<number> {
  const service = createSupabaseServiceClient();
  const since = monthStartIso();

  const { data: settled, error: sumError } = await service.rpc("sum_scrape_spend", {
    p_user_id: userId,
    p_since: since,
  });
  if (sumError) throw new Error(`spend sum failed: ${sumError.message}`);

  const { count, error: countError } = await service
    .from("scrape_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending)
    .gte("created_at", since);
  if (countError) throw new Error(`pending count failed: ${countError.message}`);

  // Reserve each in-flight run at the higher (email) unit cost.
  const reserve = (count ?? 0) * SCRAPE_UNIT_COST_USD.email;
  return Number(settled ?? 0) + reserve;
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
    const secret = process.env.APIFY_WEBHOOK_SECRET ?? "";
    // The scrape_runs id rides in the callback URL so ingest correlates by it
    // directly — no dependency on the apify_run_id write winning a race with a
    // fast run's completion webhook.
    const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?secret=${encodeURIComponent(secret)}&run=${scrapeRunId}`;
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

  // Trim the batch to the remaining monthly budget (fail-closed on error).
  const spend = await getMonthlySpendUsd(userId);
  const unit = SCRAPE_UNIT_COST_USD[mode];
  const affordable = Math.floor((MONTHLY_SCRAPE_CAP_USD - spend) / unit);
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
    const secret = process.env.APIFY_WEBHOOK_SECRET ?? "";
    const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?secret=${encodeURIComponent(secret)}&run=${scrapeRunId}`;
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
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await service
    .from("scrape_runs")
    .update({ status: ScrapeRunStatus.TimedOut, error: "No webhook within 24h", finished_at: new Date().toISOString() })
    .eq("status", ScrapeRunStatus.Pending)
    .lt("created_at", cutoff)
    .select("id");
  return ((data as { id: number }[] | null) ?? []).length;
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

async function contactHasEmail(service: ServiceClient, contactId: number): Promise<boolean> {
  const { count } = await service
    .from("contact_emails")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId);
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
    .select("id, user_id, mode, contact_ids, status")
    .limit(1);
  const { data: rows } = opts.scrapeRunId != null
    ? await query.eq("id", opts.scrapeRunId)
    : await query.eq("apify_run_id", opts.apifyRunId);
  const runRow = (rows as Array<{ id: number; user_id: string; mode: Mode; contact_ids: number[]; status: string }> | null)?.[0];
  if (!runRow) return; // unknown run — ignore
  if (runRow.status !== ScrapeRunStatus.Pending) return; // already ingested

  const contactIds = runRow.contact_ids ?? [];

  try {
    const run = await getRun(opts.apifyRunId);
    const cost = Number(run.usageTotalUsd ?? 0);

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
    const summary = await importPeopleChunk(service, runRow.user_id, inputs, undefined, "rescrape", {
      onDiffCapture: (c) => captures.push(c),
    });

    // Scrape-diff: emit change events + snapshots. Isolated — a diff failure
    // must never fail an already-merged run.
    let companyChangeContacts: number[] = [];
    try {
      companyChangeContacts = await processDiffs(service, runRow.user_id, runRow.id, items, captures, now);
    } catch (err) {
      console.error(`[scrape] diff processing failed for run ${runRow.id}:`, err);
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
    // Never leave the row pending — that would block the contact forever.
    await markRunTerminal(service, runRow.id, ScrapeRunStatus.Failed, 0, now, err instanceof Error ? err.message : "ingest failed");
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

  // Latest prior snapshot per contact (one batched query, first-wins per contact).
  const contactIds = captures.map((c) => c.contactId);
  const { data: snapRows } = await service
    .from("contact_scrape_snapshots")
    .select("contact_id, snapshot")
    .in("contact_id", contactIds)
    .order("scraped_at", { ascending: false });
  const prevByContact = new Map<number, ScrapeSnapshot>();
  for (const row of (snapRows as { contact_id: number; snapshot: ScrapeSnapshot }[] | null) ?? []) {
    if (!prevByContact.has(row.contact_id)) prevByContact.set(row.contact_id, row.snapshot);
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

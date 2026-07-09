/**
 * Scrape orchestration (plan 29 §7.2): trigger and ingest, split so no route
 * ever waits on a multi-minute Apify run.
 *
 *   trigger — validate (kill-switch, config, debounce, monthly cap,
 *     idempotency) → record a pending scrape_runs row → start the run with a
 *     completion webhook. Returns immediately.
 *   ingest — the webhook callback: load the run + dataset, rescrape-merge each
 *     item, reconcile per-contact failure tracking, and stamp the run's cost.
 *
 * The scrape_runs row is the idempotency guard: a webhook/QStash retry finds
 * the row already terminal and no-ops rather than re-merging or double-paying.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { importPeopleChunk, type PersonImportInput } from "@/lib/bulk-import";
import {
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
} from "./client";
import { actorItemToPeopleRecord } from "./rescrape-wrapper";

type Mode = "profile" | "email";
type Trigger = "manual" | "enrich_on_save" | "cadence";

export type TriggerResult =
  | { status: "started"; scrapeRunId: number; apifyRunId: string }
  | { status: "pending"; scrapeRunId: number }
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

/** Sum this calendar month's Apify spend for a user. */
export async function getMonthlySpendUsd(userId: string): Promise<number> {
  const service = createSupabaseServiceClient();
  const { data } = await service
    .from("scrape_runs")
    .select("cost_usd")
    .eq("user_id", userId)
    .gte("created_at", monthStartIso());
  return ((data as { cost_usd: number }[] | null) ?? []).reduce((sum, r) => sum + Number(r.cost_usd || 0), 0);
}

/**
 * Trigger a scrape for a single contact. Safe to call repeatedly — an in-flight
 * run for the same contact returns { status: "pending" } instead of starting a
 * second paid run.
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
    .select("id, linkedin_url, last_scraped_at")
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

  const url = canonicalizeLinkedinUrl((contact as { linkedin_url: string | null } | null)?.linkedin_url);
  if (!url) return { status: "no_url" };

  // Debounce manual/enrich re-scrapes of freshly-scraped contacts.
  const lastScrapedAt = (contact as { last_scraped_at: string | null }).last_scraped_at;
  if (trigger !== "cadence" && lastScrapedAt) {
    const ageMs = Date.now() - new Date(lastScrapedAt).getTime();
    if (ageMs < SCRAPE_DEBOUNCE_DAYS * 24 * 60 * 60 * 1000) {
      return { status: "debounced", lastScrapedAt };
    }
  }

  // Idempotency: an in-flight run already covers this contact.
  const { data: pendingRuns } = await service
    .from("scrape_runs")
    .select("id, contact_ids")
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending);
  const existing = ((pendingRuns as { id: number; contact_ids: number[] }[] | null) ?? []).find((r) =>
    (r.contact_ids ?? []).includes(contactId),
  );
  if (existing) return { status: "pending", scrapeRunId: existing.id };

  // Monthly hard cap.
  const spend = await getMonthlySpendUsd(userId);
  const unit = SCRAPE_UNIT_COST_USD[mode];
  if (spend + unit > MONTHLY_SCRAPE_CAP_USD) return { status: "cap_reached", spendUsd: spend };

  // Record the pending run BEFORE starting it (idempotency anchor).
  const { data: runRow, error: insertErr } = await service
    .from("scrape_runs")
    .insert({ user_id: userId, actor: PROFILE_SCRAPER_ACTOR, mode, trigger, contact_ids: [contactId] })
    .select("id")
    .single();
  if (insertErr || !runRow) throw new Error(`Failed to record scrape run: ${insertErr?.message}`);
  const scrapeRunId = (runRow as { id: number }).id;

  try {
    const secret = process.env.APIFY_WEBHOOK_SECRET ?? "";
    const callbackUrl = `${getAppBaseUrl()}/api/apify/run-callback?secret=${encodeURIComponent(secret)}`;
    const run = await startProfileScrapeRun({
      urls: [url],
      mode,
      // A little headroom over the single-profile unit cost; the webhook
      // reports the real spend afterwards.
      maxTotalChargeUsd: Math.max(0.05, unit * 3),
      callbackUrl,
    });
    await service.from("scrape_runs").update({ apify_run_id: run.id }).eq("id", scrapeRunId);
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
 * Ingest a finished Apify run (called by the webhook callback). Idempotent:
 * a run already marked terminal is a no-op.
 */
export async function ingestScrapeRun(apifyRunId: string): Promise<void> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();

  const { data: runRow } = await service
    .from("scrape_runs")
    .select("id, user_id, mode, contact_ids, status")
    .eq("apify_run_id", apifyRunId)
    .single();
  if (!runRow) return; // unknown run — ignore
  const row = runRow as { id: number; user_id: string; mode: Mode; contact_ids: number[]; status: string };
  if (row.status !== ScrapeRunStatus.Pending) return; // already ingested

  const contactIds = row.contact_ids ?? [];

  let run;
  try {
    run = await getRun(apifyRunId);
  } catch {
    return; // transient — the daily sweep will re-queue if it stays pending
  }

  const cost = Number(run.usageTotalUsd ?? 0);

  if (run.status !== "SUCCEEDED") {
    await markRunFailed(service, row.id, ScrapeRunStatus.Failed, cost, now, `Apify run ${run.status}`);
    await bumpFailures(service, contactIds, now);
    return;
  }

  const items = await getDatasetItems(run.defaultDatasetId);
  if (items.length === 0) {
    // Reachable-but-empty: private/removed profile. Treat as a soft failure.
    await markRunSucceeded(service, row.id, cost, now);
    await bumpFailures(service, contactIds, now);
    return;
  }

  const inputs: PersonImportInput[] = items.map((item) => ({
    record: actorItemToPeopleRecord(item, { emailSearched: row.mode === ScrapeMode.Email }),
  }));

  const summary = await importPeopleChunk(service, row.user_id, inputs, undefined, "rescrape");

  // Correlate results back to contacts by canonical URL to reset/bump failures.
  const okUrls = new Set(
    summary.results
      .filter((r) => r.status === "updated" || r.status === "created")
      .map((r) => canonicalizeLinkedinUrl(r.linkedin_url))
      .filter(Boolean) as string[],
  );
  const { data: contactRows } = await service
    .from("contacts")
    .select("id, linkedin_url")
    .in("id", contactIds);
  const succeeded: number[] = [];
  const failed: number[] = [];
  for (const c of (contactRows as { id: number; linkedin_url: string | null }[] | null) ?? []) {
    const cu = canonicalizeLinkedinUrl(c.linkedin_url);
    if (cu && okUrls.has(cu)) succeeded.push(c.id);
    else failed.push(c.id);
  }

  await markRunSucceeded(service, row.id, cost, now);
  if (succeeded.length) await resetFailures(service, succeeded);
  if (failed.length) await bumpFailures(service, failed, now);
}

async function markRunSucceeded(service: ReturnType<typeof createSupabaseServiceClient>, id: number, cost: number, now: string) {
  await service
    .from("scrape_runs")
    .update({ status: ScrapeRunStatus.Succeeded, cost_usd: cost, finished_at: now })
    .eq("id", id);
}

async function markRunFailed(
  service: ReturnType<typeof createSupabaseServiceClient>,
  id: number,
  status: string,
  cost: number,
  now: string,
  error: string,
) {
  await service.from("scrape_runs").update({ status, cost_usd: cost, error, finished_at: now }).eq("id", id);
}

async function resetFailures(service: ReturnType<typeof createSupabaseServiceClient>, ids: number[]) {
  await service.from("contacts").update({ scrape_failure_count: 0, scrape_failed_at: null }).in("id", ids);
}

async function bumpFailures(service: ReturnType<typeof createSupabaseServiceClient>, ids: number[], now: string) {
  if (!ids.length) return;
  // Read-modify-write the small set (no atomic increment in the JS client).
  const { data } = await service.from("contacts").select("id, scrape_failure_count").in("id", ids);
  for (const c of (data as { id: number; scrape_failure_count: number | null }[] | null) ?? []) {
    await service
      .from("contacts")
      .update({ scrape_failure_count: (c.scrape_failure_count ?? 0) + 1, scrape_failed_at: now })
      .eq("id", c.id);
  }
}

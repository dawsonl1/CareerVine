/**
 * Minimal Apify REST client for the LinkedIn profile scraper (plan 29).
 *
 * No SDK dependency — a few typed fetch calls. Runs are started asynchronously
 * with a completion webhook and a hard maxTotalChargeUsd cap; the callback
 * route fetches the run + dataset when it finishes. See scrape-service.ts.
 *
 * Required env:
 *   APIFY_API_TOKEN      — account token (global CLAUDE.md: $APIFY_API_TOKEN)
 *   APIFY_WEBHOOK_SECRET — shared secret the callback verifies
 *   APP_BASE_URL         — absolute origin used to build the webhook URL
 *                          (falls back to https://$VERCEL_URL)
 */

import {
  DISCOVERY_FUNCTION_IDS,
  PROFILE_SCRAPER_ACTOR,
  PROFILE_SEARCH_ACTOR,
  PROFILE_SEARCH_BY_NAME_ACTOR,
} from "@/lib/constants";
import { ApiError } from "@/lib/api-handler";

const APIFY_BASE = "https://api.apify.com/v2";

/** Exact actor input enum strings for the scraper mode. */
const MODE_INPUT: Record<"profile" | "email", string> = {
  profile: "Profile details no email ($4 per 1k)",
  email: "Profile details + email search ($10 per 1k)",
};

/** Terminal Apify run events we want the callback to fire on. */
const WEBHOOK_EVENT_TYPES = [
  "ACTOR.RUN.SUCCEEDED",
  "ACTOR.RUN.FAILED",
  "ACTOR.RUN.ABORTED",
  "ACTOR.RUN.TIMED_OUT",
];

/**
 * Header the completion webhook presents the shared secret in (CAR-140 / F26).
 * Carrying it here instead of a query-string param keeps it out of Apify's run
 * logs and our access logs. Not one of Apify's reserved headers, so it passes
 * through the webhook dispatcher unchanged.
 */
export const APIFY_WEBHOOK_SECRET_HEADER = "X-Careervine-Webhook-Secret";

/**
 * Base64-encoded ad-hoc webhook array for a terminal-event completion callback,
 * with the shared secret attached as a custom header via Apify's headersTemplate.
 * `run` still rides in the callback URL (it's a non-secret correlation id).
 */
function terminalWebhookParam(callbackUrl: string): string {
  const secret = process.env.APIFY_WEBHOOK_SECRET ?? "";
  return Buffer.from(
    JSON.stringify([
      {
        eventTypes: WEBHOOK_EVENT_TYPES,
        requestUrl: callbackUrl,
        headersTemplate: JSON.stringify({ [APIFY_WEBHOOK_SECRET_HEADER]: secret }),
      },
    ]),
  ).toString("base64");
}

/** Shape of one harvestapi profile dataset item (subset the mapper consumes). */
export interface ApifyProfileItem {
  linkedinUrl?: string | null;
  publicIdentifier?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  photo?: string | null;
  location?: { linkedinText?: string | null; parsed?: { city?: string | null; state?: string | null; country?: string | null } | null } | null;
  emails?: Array<string | { email?: string | null }> | null;
  experience?: unknown[] | null;
  education?: unknown[] | null;
  [key: string]: unknown;
}

export interface ApifyRun {
  id: string;
  status: string; // READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT
  defaultDatasetId: string;
  usageTotalUsd?: number | null;
}

export function getApifyToken(): string {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new ApiError("Apify API token not configured", 500);
  return token;
}

export function isApifyConfigured(): boolean {
  return Boolean(process.env.APIFY_API_TOKEN && process.env.APIFY_WEBHOOK_SECRET && getAppBaseUrl(false));
}

export function getAppBaseUrl(required = true): string {
  const base = process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!base && required) throw new ApiError("APP_BASE_URL not configured (needed for Apify webhook)", 500);
  return base.replace(/\/+$/, "");
}

function actorPath(): string {
  // REST path form: username~actorname
  return PROFILE_SCRAPER_ACTOR.replace("/", "~");
}

/**
 * Start a profile-scraper run with a completion webhook and a hard spend cap.
 * Returns the run id and its default dataset id. Does NOT wait for completion.
 */
export async function startProfileScrapeRun(opts: {
  urls: string[];
  mode: "profile" | "email";
  maxTotalChargeUsd: number;
  callbackUrl: string;
}): Promise<ApifyRun> {
  const token = getApifyToken();

  const webhooks = terminalWebhookParam(opts.callbackUrl);

  const params = new URLSearchParams({
    token,
    maxTotalChargeUsd: String(opts.maxTotalChargeUsd),
    webhooks,
  });

  const res = await fetch(`${APIFY_BASE}/acts/${actorPath()}/runs?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileScraperMode: MODE_INPUT[opts.mode],
      queries: opts.urls,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`Apify run start failed (${res.status}): ${text.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { data?: ApifyRun };
  if (!json.data?.id) throw new ApiError("Apify run start returned no run id", 502);
  return json.data;
}

/** Fetch a run's current status, dataset id, and (when finished) total cost. */
export async function getRun(runId: string): Promise<ApifyRun> {
  const token = getApifyToken();
  const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
  if (!res.ok) throw new ApiError(`Apify getRun failed (${res.status})`, 502);
  const json = (await res.json()) as { data?: ApifyRun };
  if (!json.data) throw new ApiError("Apify getRun returned no data", 502);
  return json.data;
}

/** Fetch all items from a finished run's default dataset. */
export async function getDatasetItems(datasetId: string): Promise<ApifyProfileItem[]> {
  const token = getApifyToken();
  const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&clean=true&format=json`);
  if (!res.ok) throw new ApiError(`Apify dataset fetch failed (${res.status})`, 502);
  return (await res.json()) as ApifyProfileItem[];
}

/**
 * Actor C (plan 41): start a discovery people-search run — new hires in a PM
 * function at one target company. Short mode, one page (≤25 short profiles,
 * $0.10); async with the same terminal-event webhook as the profile scraper.
 */
export async function startProfileSearchRun(opts: {
  companyLinkedinUrl: string;
  maxTotalChargeUsd: number;
  callbackUrl: string;
}): Promise<ApifyRun> {
  const token = getApifyToken();

  const webhooks = terminalWebhookParam(opts.callbackUrl);

  const params = new URLSearchParams({
    token,
    maxTotalChargeUsd: String(opts.maxTotalChargeUsd),
    webhooks,
  });

  const actor = PROFILE_SEARCH_ACTOR.replace("/", "~");
  const res = await fetch(`${APIFY_BASE}/acts/${actor}/runs?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileScraperMode: "Short",
      currentCompanies: [opts.companyLinkedinUrl],
      functionIds: DISCOVERY_FUNCTION_IDS,
      recentlyChangedJobs: true,
      maxItems: 25,
      takePages: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`Apify discovery run start failed (${res.status}): ${text.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { data?: ApifyRun };
  if (!json.data?.id) throw new ApiError("Apify discovery run start returned no run id", 502);
  return json.data;
}

/** One short profile from the search-by-name actor. */
export interface ApifySearchProfileItem {
  linkedinUrl?: string | null;
  publicIdentifier?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  photo?: string | null;
  location?: { linkedinText?: string | null } | string | null;
  [key: string]: unknown;
}

/**
 * Actor B (plan 29 §2): resolve a person by name, synchronously. Short mode,
 * one search page (≤10 short profiles, $0.004) — fast enough for an
 * interactive picker via Apify's run-sync endpoint. `currentCompanies`
 * (company LinkedIn URLs) and `locations` narrow ambiguous names.
 */
export async function searchProfilesByName(opts: {
  firstName: string;
  lastName?: string;
  currentCompanies?: string[];
  locations?: string[];
}): Promise<ApifySearchProfileItem[]> {
  const token = getApifyToken();
  const actor = PROFILE_SEARCH_BY_NAME_ACTOR.replace("/", "~");
  // Server-side wait, bounded under our route's maxDuration. maxTotalChargeUsd
  // keeps the platform-enforced spend invariant: the input's maxPages/maxItems
  // bound is actor-honored trust, not a guarantee ($0.02 ≈ 5 search pages of
  // headroom over the expected single $0.004 page).
  const res = await fetch(`${APIFY_BASE}/acts/${actor}/run-sync-get-dataset-items?token=${token}&timeout=45&maxTotalChargeUsd=0.02`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileScraperMode: "Short",
      firstName: opts.firstName,
      ...(opts.lastName ? { lastName: opts.lastName } : {}),
      strictSearch: true,
      maxPages: 1,
      maxItems: 10,
      ...(opts.currentCompanies?.length ? { currentCompanies: opts.currentCompanies } : {}),
      ...(opts.locations?.length ? { locations: opts.locations } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`LinkedIn search failed (${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return (await res.json()) as ApifySearchProfileItem[];
}

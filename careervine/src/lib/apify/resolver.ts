/**
 * LinkedIn profile resolver (plan 29 §6.3 / §7.5) — actor B's two jobs:
 *   1. No-URL contacts (manual adds): find their profile by name so they can
 *      enter the normal scrape lifecycle.
 *   2. URL-rot repair: a contact whose stored URL keeps 404ing (renamed
 *      public identifier) gets re-found and re-linked.
 *
 * resolveContactLinkedin returns candidates for the picker UI (a search is
 * $0.004, ledgered under mode='resolve'); linkContactLinkedin writes the
 * chosen canonical URL and kicks an enrich scrape so the contact fills in.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { canonicalizeLinkedinUrl, extractPublicIdentifier } from "@/lib/linkedin-url";
import { updateContact } from "@/lib/data/contacts";
import { must, type QueryClient } from "@/lib/data/client";
import { ApiError } from "@/lib/api-handler";
import {
  MONTHLY_SCRAPE_CAP_USD,
  PROFILE_SEARCH_BY_NAME_ACTOR,
  RESOLVE_COST_USD,
  ScrapeRunStatus,
} from "@/lib/constants";
import { searchProfilesByName, isApifyConfigured, type ApifySearchProfileItem } from "./client";
import { getMonthlySpendUsd, triggerEnrichOnSave, type TriggerResult } from "./scrape-service";
import { getApifyControls } from "./account-controls";

export interface ResolveCandidate {
  linkedinUrl: string; // canonical
  name: string;
  headline: string | null;
  photo: string | null;
  location: string | null;
}

export type ResolveResult =
  | { status: "candidates"; candidates: ResolveCandidate[] }
  | { status: "cap_reached" }
  | { status: "disabled" }
  | { status: "disabled_by_admin" };

export async function resolveContactLinkedin(userId: string, contactId: number): Promise<ResolveResult> {
  if (process.env.APIFY_SCRAPE_DISABLED === "true" || !isApifyConfigured()) return { status: "disabled" };
  const service = createSupabaseServiceClient();

  // Per-account admin kill switch (plan 36) — the search page costs money too.
  const controls = await getApifyControls(service, userId);
  if (!controls.enrichmentEnabled) return { status: "disabled_by_admin" };

  // maybeSingle, not single: "no such contact for this user" is the 404 below,
  // but a real read failure must surface as a 500 instead of a false 404.
  const contact = must(
    await service
      .from("contacts")
      .select("id, name, contact_companies(is_current, companies(linkedin_url)), locations(city, state)")
      .eq("id", contactId)
      .eq("user_id", userId)
      .maybeSingle(),
  );
  if (!contact) throw new ApiError("Contact not found", 404);

  const c = contact as {
    name: string;
    contact_companies?: Array<{ is_current: boolean | null; companies: { linkedin_url: string | null } | { linkedin_url: string | null }[] | null }>;
    locations?: { city: string | null; state: string | null } | { city: string | null; state: string | null }[] | null;
  };

  const spend = await getMonthlySpendUsd(userId);
  if (spend + RESOLVE_COST_USD > MONTHLY_SCRAPE_CAP_USD) return { status: "cap_reached" };

  // Disambiguators: the current company's LinkedIn URL beats a location.
  const companyUrls: string[] = [];
  for (const cc of c.contact_companies ?? []) {
    if (!cc.is_current) continue;
    const company = Array.isArray(cc.companies) ? cc.companies[0] : cc.companies;
    if (company?.linkedin_url) companyUrls.push(company.linkedin_url);
  }
  const loc = Array.isArray(c.locations) ? c.locations[0] : c.locations;
  const locationText = loc ? [loc.city, loc.state].filter(Boolean).join(" ") : null;

  const nameParts = c.name.trim().split(/\s+/);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ") || undefined;
  if (!firstName) throw new ApiError("Contact has no usable name to search", 400);

  // Ledger BEFORE the call (run-sync gives no usage back; the short-page price
  // is fixed): a search that starts charging and then throws — 45s timeout
  // aborting a charged run, non-2xx after the page — must still land in the
  // cap accounting. A failed insert blocks the spend (fail closed).
  const { error: ledgerError } = await service.from("scrape_runs").insert({
    user_id: userId,
    actor: PROFILE_SEARCH_BY_NAME_ACTOR,
    mode: "resolve",
    trigger: "manual",
    contact_ids: [contactId],
    status: ScrapeRunStatus.Succeeded,
    cost_usd: RESOLVE_COST_USD,
    finished_at: new Date().toISOString(),
  });
  if (ledgerError) {
    console.error("[apify/resolver] scrape_runs ledger insert failed:", ledgerError);
    throw new ApiError("Could not record the search. Please try again.", 500);
  }

  const items = await searchProfilesByName({
    firstName,
    lastName,
    currentCompanies: companyUrls.slice(0, 3),
    locations: !companyUrls.length && locationText ? [locationText] : undefined,
  });

  return { status: "candidates", candidates: toCandidates(items) };
}

function toCandidates(items: ApifySearchProfileItem[]): ResolveCandidate[] {
  const out: ResolveCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = canonicalizeLinkedinUrl(
      item.linkedinUrl ?? (item.publicIdentifier ? `https://www.linkedin.com/in/${item.publicIdentifier}` : null),
    );
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = item.name?.trim() || `${item.firstName ?? ""} ${item.lastName ?? ""}`.trim();
    if (!name) continue;
    const location = typeof item.location === "string" ? item.location : item.location?.linkedinText ?? null;
    out.push({
      linkedinUrl: url,
      name,
      headline: item.headline?.trim() || null,
      photo: item.photo?.trim() || null,
      location: location?.trim() || null,
    });
  }
  return out;
}

/**
 * Write the chosen URL onto the contact and kick an enrich scrape. Refuses a
 * URL already linked to another of the user's contacts (would create a
 * duplicate identity).
 */
export async function linkContactLinkedin(
  userId: string,
  contactId: number,
  url: string,
): Promise<{ linkedinUrl: string; enrich: TriggerResult["status"] }> {
  const canonical = canonicalizeLinkedinUrl(url);
  if (!canonical) throw new ApiError("Not a valid LinkedIn profile URL", 400);

  const service = createSupabaseServiceClient();

  const holder = must(
    await service
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("linkedin_url", canonical)
      .neq("id", contactId)
      .limit(1)
      .maybeSingle(),
  );
  if (holder) throw new ApiError("Another contact already uses that LinkedIn profile", 409);

  // Shared write chokepoint (CAR-155); throws when no row matches, which
  // keeps the historical 404 semantics for a missing/foreign contact.
  try {
    await updateContact(
      contactId,
      {
        linkedin_url: canonical,
        public_identifier: extractPublicIdentifier(canonical),
        // A fresh link invalidates the old failure streak.
        scrape_failure_count: 0,
        scrape_failed_at: null,
      },
      { client: service as unknown as QueryClient, userId },
    );
  } catch {
    throw new ApiError("Contact not found", 404);
  }

  const enrich = await triggerEnrichOnSave(userId, contactId);
  return { linkedinUrl: canonical, enrich: enrich.status };
}

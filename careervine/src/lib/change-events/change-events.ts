/**
 * contact_change_events persistence layer (plan 29).
 *
 * Producer + reader for detected contact changes. Phase 0 wires only the
 * anniversary producer; scrape-diff producers (phases 2/3) will write into the
 * same table. Reader maps surfaceable (tier 1/2, status 'new') events into the
 * ephemeral Suggestion shape so they flow through the existing Up Next feed UI.
 *
 * Follows the generate-suggestions convention: a service client is created
 * inside each function and every query is explicitly scoped by user_id.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ChangeEventStatus, ChangeEventTier } from "@/lib/constants";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";
import { computeAnniversaryEvents, type AnniversaryContact } from "./anniversary";

/**
 * Detect this month's work anniversaries for a user's active/prospect contacts
 * and upsert them as change events. Idempotent: ON CONFLICT (user_id,
 * dedupe_key) DO NOTHING, so re-running never revives a dismissed/actioned
 * event nor duplicates a still-new one. Bench contacts are excluded
 * (plan-24 containment). Returns the number of candidate events considered.
 */
export async function syncAnniversaryEvents(userId: string, today: Date = new Date()): Promise<number> {
  const service = createSupabaseServiceClient();

  const { data: contacts, error } = await service
    .from("contacts")
    .select("id, name, photo_url, industry, contact_companies(company_id, start_month, is_current, companies(name))")
    .eq("user_id", userId)
    .in("network_status", ["active", "prospect"]);

  if (error || !contacts) return 0;

  const shaped: AnniversaryContact[] = contacts.map((c) => {
    const cc = (c as { contact_companies?: unknown[] }).contact_companies ?? [];
    return {
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      industry: c.industry,
      employment: (cc as Array<{ company_id: number | null; start_month: string | null; is_current: boolean | null; companies?: { name?: string | null } | { name?: string | null }[] | null }>).map((row) => {
        const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
        return {
          company_id: row.company_id ?? null,
          company_name: company?.name ?? null,
          start_month: row.start_month ?? null,
          is_current: row.is_current ?? null,
        };
      }),
    };
  });

  const events = computeAnniversaryEvents(shaped, today);
  if (events.length === 0) return 0;

  const rows = events.map((e) => ({
    user_id: userId,
    contact_id: e.contactId,
    type: e.type,
    tier: e.tier,
    dedupe_key: e.dedupeKey,
    headline: e.headline,
    evidence: e.evidence,
    suggested_title: e.suggestedTitle,
    suggested_description: e.suggestedDescription,
  }));

  const { error: upsertError } = await service
    .from("contact_change_events")
    .upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });

  if (upsertError) {
    console.error("[change-events] anniversary upsert failed:", upsertError);
    return 0;
  }

  return rows.length;
}

/**
 * Read surfaceable new change events for a user and map them into the Suggestion
 * shape used by the Up Next feed. Tier-3 (silent) events are never returned.
 */
export async function fetchChangeEventSuggestions(userId: string): Promise<Suggestion[]> {
  const service = createSupabaseServiceClient();

  const { data, error } = await service
    .from("contact_change_events")
    .select("id, contact_id, type, tier, headline, evidence, suggested_title, suggested_description, contacts(name, photo_url, industry)")
    .eq("user_id", userId)
    .eq("status", ChangeEventStatus.New)
    .in("tier", [ChangeEventTier.ActNow, ChangeEventTier.Touchpoint])
    .order("tier", { ascending: true })
    .order("detected_at", { ascending: false });

  if (error || !data) return [];

  return data.map((e) => {
    const contact = Array.isArray(e.contacts) ? e.contacts[0] : e.contacts;
    const name = contact?.name ?? "Contact";
    return {
      id: `ce-${e.id}`,
      changeEventId: e.id,
      contactId: e.contact_id,
      contactName: name,
      contactPhotoUrl: contact?.photo_url ?? null,
      contactIndustry: contact?.industry ?? null,
      headline: e.headline,
      evidence: e.evidence ?? "",
      reasonType: e.type,
      // Tier-1 (act now) outranks tier-2 touchpoints in the feed's score sort.
      score: e.tier === ChangeEventTier.ActNow ? 88 : 78,
      suggestedTitle: e.suggested_title ?? `Reach out to ${name}`,
      suggestedDescription: e.suggested_description ?? "",
      daysSinceContact: null,
    } satisfies Suggestion;
  });
}

/**
 * Transition a change event's status. Scoped to the owning user. 'actioned'
 * also stamps actioned_at.
 */
export async function markChangeEventStatus(
  eventId: number,
  userId: string,
  status: (typeof ChangeEventStatus)[keyof typeof ChangeEventStatus],
): Promise<void> {
  const service = createSupabaseServiceClient();
  const patch: { status: string; actioned_at?: string } = { status };
  if (status === ChangeEventStatus.Actioned) {
    patch.actioned_at = new Date().toISOString();
  }
  await service
    .from("contact_change_events")
    .update(patch)
    .eq("id", eventId)
    .eq("user_id", userId);
}

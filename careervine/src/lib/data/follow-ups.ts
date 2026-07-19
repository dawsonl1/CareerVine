/**
 * Reach-out cadence and relationship-health queries: last-touch
 * computation, on-track/neglected/health rollups, and the per-contact
 * reach-out snooze/skip/cooldown controls (CAR-146 split of queries.ts).
 *
 * Client resolution is lazy via db(); functions throw on failure unless
 * annotated error-tolerated.
 */

import { db, must } from "./client";
import { chunked, paginateAll } from "./postgrest";
import { SUGGESTION_COOLDOWN_DAYS } from "@/lib/constants";
import { deriveDueFollowUps, type DueFollowUpEntry } from "@/lib/rules/due-follow-ups";
import { deriveRelationshipsOnTrack } from "@/lib/rules/on-track";
import { deriveNeglectedContacts } from "@/lib/rules/neglected";

/** Get a suggestion cooldown timestamp (now + SUGGESTION_COOLDOWN_DAYS) */
function getSuggestionCooldownTimestamp(): string {
  const d = new Date();
  d.setDate(d.getDate() + SUGGESTION_COOLDOWN_DAYS);
  return d.toISOString();
}

/**
 * Build a map of contact_id → last touch date string.
 * Shared across multiple queries that need last-touch data.
 * must(): the map drives follow-up nags and health surfaces — an errored
 * read must not render every contact as "never contacted".
 *
 * Explicitly user-scoped on both legs (CAR-151): this function also runs
 * under the MCP service-role client, where RLS does not filter foreign
 * meetings/interactions out of the joins.
 *
 * Internal to src/lib/data (not re-exported from the queries barrel).
 */
export async function buildLastTouchMap(userId: string, contactIds: number[]): Promise<Map<number, string>> {
  if (contactIds.length === 0) return new Map();

  // Each chunk's rows are paginated too: 200 contacts can carry well over
  // 1000 touches between them, and PostgREST truncates silently at its row
  // cap. meeting_contacts has no id column — (contact_id, meeting_id) is
  // its unique composite, so that pair is the stable pagination order.
  const [meetingLinks, interactions] = await Promise.all([
    chunked(contactIds, async (chunk) =>
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("meeting_contacts")
            .select("contact_id, meetings!inner(meeting_date)")
            .eq("meetings.user_id", userId)
            .in("contact_id", chunk)
            .order("contact_id")
            .order("meeting_id")
            .range(from, to),
        ),
      ),
    ),
    chunked(contactIds, async (chunk) =>
      paginateAll(async (from, to) =>
        must(
          await db()
            .from("interactions")
            .select("contact_id, interaction_date, contacts!inner()")
            .eq("contacts.user_id", userId)
            .in("contact_id", chunk)
            .order("id")
            .range(from, to),
        ),
      ),
    ),
  ]);

  const map = new Map<number, string>();
  for (const ml of meetingLinks) {
    const date = ml.meetings?.meeting_date;
    if (!date) continue;
    const prev = map.get(ml.contact_id);
    if (!prev || date > prev) map.set(ml.contact_id, date);
  }
  for (const i of interactions) {
    const date = i.interaction_date;
    if (!date) continue;
    const prev = map.get(i.contact_id);
    if (!prev || date > prev) map.set(i.contact_id, date);
  }
  return map;
}

/**
 * Standalone reach-out list fetch (CAR-151): the same derivation the home
 * page renders, fetched fresh. Explicitly user-scoped so it is safe under
 * the MCP service-role client. The due/overdue policy itself lives in
 * src/lib/rules/due-follow-ups.ts (CAR-155).
 */
export async function getDueFollowUps(userId: string): Promise<DueFollowUpEntry[]> {
  const nowIso = new Date().toISOString();
  const contacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, reach_out_snoozed_until, network_status, contact_emails(email)")
        .eq("user_id", userId)
        .eq("network_status", "active") // reach-out prompts cover the real network only (matches getHomeCoreData; the rule re-enforces this)
        .order("name")
        .order("id")
        .range(from, to),
    ),
  );
  if (contacts.length === 0) return [];
  const lastTouchMap = await buildLastTouchMap(userId, contacts.map((c) => c.id));
  return deriveDueFollowUps(contacts, lastTouchMap, nowIso);
}

/**
 * Snooze a contact's reach-out / recently-added card until a given time.
 * Also sets suggestion_cooldown_until to 3 weeks from now.
 */
export async function snoozeContact(contactId: number, until: string) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await db()
    .from("contacts")
    .update({
      reach_out_snoozed_until: until,
      suggestion_cooldown_until: cooldown,
    })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Permanently skip first outreach for a contact.
 * Also sets suggestion_cooldown_until to 3 weeks from now.
 */
export async function skipContactFirstOutreach(contactId: number) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await db()
    .from("contacts")
    .update({
      first_outreach_skipped: true,
      suggestion_cooldown_until: cooldown,
    })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Set suggestion cooldown on a contact (e.g., after dismissing an AI suggestion).
 */
export async function setSuggestionCooldown(contactId: number) {
  const cooldown = getSuggestionCooldownTimestamp();
  const { error } = await db()
    .from("contacts")
    .update({ suggestion_cooldown_until: cooldown })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Get all contacts with their last interaction/meeting date for the relationship health grid.
 * Returns a lightweight projection: id, name, industry, last_touch date, and days since last touch.
 *
 * Internal to src/lib/data (not re-exported from the queries barrel):
 * app surfaces consume it through getNetworkHealthSummary / getNeglectedContacts.
 *
 * @param userId - The user's ID
 * @returns Promise<ContactHealth[]> - All contacts with recency data
 */
export async function getContactsWithLastTouch(userId: string) {
  // Paginated, not capped: its sibling getRelationshipsOnTrack is unbounded and
  // getNetworkHealth composes both, so a cap here would pair a whole-network
  // on-track ratio with an alphabetically-truncated neglected list. Name order
  // drives display; id is the tiebreak that keeps range windows stable.
  const contacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, network_status")
        .eq("user_id", userId)
        .eq("network_status", "active") // health grid covers the real network only (matches getHomeCoreData)
        .order("name")
        .order("id")
        .range(from, to),
    ),
  );
  if (contacts.length === 0) return [];

  const lastTouchMap = await buildLastTouchMap(userId, contacts.map((c) => c.id));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return contacts.map((c) => {
    const lastTouch = lastTouchMap.get(c.id) || null;
    const daysSinceTouch = lastTouch
      ? Math.floor((today.getTime() - new Date(lastTouch).getTime()) / (1000 * 60 * 60 * 24))
      : null; // null means never contacted
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      photo_url: c.photo_url,
      follow_up_frequency_days: c.follow_up_frequency_days,
      created_at: c.created_at,
      first_outreach_skipped: c.first_outreach_skipped,
      network_status: c.network_status,
      last_touch: lastTouch,
      days_since_touch: daysSinceTouch,
    };
  });
}

/**
 * Calculate "Relationships on track" percentage.
 * The on-track policy itself lives in src/lib/rules/on-track.ts (CAR-155);
 * this wrapper fetches the population and hands it to the rule.
 */
export async function getRelationshipsOnTrack(userId: string) {
  const nowIso = new Date().toISOString();

  const contacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("id, follow_up_frequency_days, created_at, first_outreach_skipped, network_status")
        .eq("user_id", userId)
        .eq("network_status", "active") // on-track % covers the real network only (matches getHomeCoreData; the rule re-enforces this)
        .order("id")
        .range(from, to),
    ),
  );
  if (contacts.length === 0) {
    return deriveRelationshipsOnTrack([], new Map(), nowIso);
  }

  const lastTouchMap = await buildLastTouchMap(userId, contacts.map((c) => c.id));
  return deriveRelationshipsOnTrack(contacts, lastTouchMap, nowIso);
}

/**
 * Get network health summary for the donut chart.
 * Returns counts by category: healthy, due, overdue, neverContacted, noCadence.
 */
export async function getNetworkHealthSummary(userId: string) {
  const contacts = await getContactsWithLastTouch(userId);

  const summary = { healthy: 0, dueSoon: 0, overdue: 0, neverContacted: 0, noCadence: 0, total: contacts.length };

  for (const c of contacts) {
    if (!c.follow_up_frequency_days) {
      if (c.days_since_touch === null) summary.neverContacted++;
      else summary.noCadence++;
      continue;
    }
    if (c.days_since_touch === null) {
      summary.neverContacted++;
      continue;
    }
    const ratio = c.days_since_touch / c.follow_up_frequency_days;
    if (ratio <= 0.85) summary.healthy++;
    else if (ratio <= 1.0) summary.dueSoon++;
    else summary.overdue++;
  }

  return summary;
}

/**
 * Get contacts that are 2x+ past their follow-up cadence (neglected relationships).
 * The neglected policy itself lives in src/lib/rules/neglected.ts (CAR-155);
 * this wrapper fetches the population and hands it to the rule.
 */
export async function getNeglectedContacts(userId: string) {
  const contacts = await getContactsWithLastTouch(userId);
  return deriveNeglectedContacts(contacts);
}

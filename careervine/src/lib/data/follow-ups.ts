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
import { RECENTLY_ADDED_DAYS, SUGGESTION_COOLDOWN_DAYS } from "@/lib/constants";

/**
 * Get the ISO cutoff string for the "Recently Added" window.
 * Internal to src/lib/data (not re-exported from the queries barrel).
 */
export function getRecentCutoff(): string {
  const d = new Date();
  d.setDate(d.getDate() - RECENTLY_ADDED_DAYS);
  return d.toISOString();
}

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

/** Source row shape for the reach-out derivation (matches the home fetch). */
export interface DueFollowUpSourceRow {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number | null;
  photo_url: string | null;
  created_at: string;
  first_outreach_skipped: boolean | null;
  reach_out_snoozed_until: string | null;
  contact_emails: Array<{ email: string | null }> | null;
}

export interface DueFollowUpEntry {
  id: number;
  name: string;
  industry: string | null;
  photo_url: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
  never_contacted: boolean;
  no_cadence: boolean;
  emails: string[];
}

/**
 * Derive the "reach out" list from a set of active contacts + their
 * last-touch map. Single source of the due/overdue policy: consumed by
 * getHomeCoreData (which already holds the contacts) and by
 * getContactsDueForFollowUp / the MCP list_due_follow_ups tool (CAR-151),
 * so the surfaces cannot drift.
 */
export function deriveDueFollowUps(
  contacts: DueFollowUpSourceRow[],
  lastTouchMap: Map<number, string>,
  nowIso: string,
): DueFollowUpEntry[] {
  const recentCutoff = getRecentCutoff();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isSnoozed = (c: DueFollowUpSourceRow) =>
    Boolean(c.reach_out_snoozed_until && new Date(c.reach_out_snoozed_until) > new Date(nowIso));

  return contacts
    .map((c) => {
      if (isSnoozed(c)) return null;

      const lastTouch = lastTouchMap.get(c.id);
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const freqDays = c.follow_up_frequency_days;
      const neverContacted = !lastTouchDate;
      const noCadence = !freqDays;
      const isRecent = c.created_at >= recentCutoff;

      if (neverContacted && (isRecent || c.first_outreach_skipped)) return null;

      const emails = (c.contact_emails || [])
        .map((e) => e.email)
        .filter((email): email is string => email !== null);

      if (noCadence) {
        if (!neverContacted || !isRecent) {
          return {
            id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
            follow_up_frequency_days: 0, last_touch: lastTouch || null,
            days_overdue: 0, never_contacted: neverContacted, no_cadence: true,
            emails,
          };
        }
        return null;
      }

      let daysOverdue: number;
      if (neverContacted) {
        const dueDate = new Date(c.created_at);
        dueDate.setDate(dueDate.getDate() + freqDays!);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        const dueDate = new Date(lastTouchDate!);
        dueDate.setDate(dueDate.getDate() + freqDays!);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      }
      if (daysOverdue < 0) return null;

      return {
        id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
        follow_up_frequency_days: freqDays!, last_touch: lastTouch || null,
        days_overdue: daysOverdue, never_contacted: neverContacted, no_cadence: false,
        emails,
      };
    })
    .filter((c): c is DueFollowUpEntry => c !== null)
    .sort((a, b) => {
      if (a.no_cadence && !b.no_cadence) return 1;
      if (!a.no_cadence && b.no_cadence) return -1;
      return b.days_overdue - a.days_overdue;
    });
}

/**
 * Standalone reach-out list fetch (CAR-151): the same derivation the home
 * page renders, fetched fresh. Explicitly user-scoped so it is safe under
 * the MCP service-role client.
 */
export async function getContactsDueForFollowUp(userId: string): Promise<DueFollowUpEntry[]> {
  const nowIso = new Date().toISOString();
  const contacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, reach_out_snoozed_until, contact_emails(email)")
        .eq("user_id", userId)
        .eq("network_status", "active") // reach-out prompts cover the real network only (matches getHomeCoreData)
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
  const { data: contacts, error: cErr } = await db()
    .from("contacts")
    .select("id, name, industry, follow_up_frequency_days, photo_url")
    .eq("user_id", userId)
    .eq("network_status", "active") // health grid covers the real network only (matches getHomeCoreData)
    .order("name")
    .limit(500);
  if (cErr) throw cErr;
  if (!contacts || contacts.length === 0) return [];

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
      last_touch: lastTouch,
      days_since_touch: daysSinceTouch,
    };
  });
}

/**
 * Calculate "Relationships on track" percentage.
 *
 * Denominator: contacts that have been contacted at least once OR
 * are past the 7-day Recently Added window (excluding first_outreach_skipped).
 *
 * Numerator: contacts where days_since_last_touch <= follow_up_frequency_days.
 * Contacts with no cadence set are automatically NOT on track.
 *
 * Returns percentage + breakdown for tooltip.
 */
export async function getRelationshipsOnTrack(userId: string) {
  const recentCutoff = getRecentCutoff();

  const contacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("id, follow_up_frequency_days, created_at, first_outreach_skipped")
        .eq("user_id", userId)
        .eq("network_status", "active") // on-track % covers the real network only (matches getHomeCoreData)
        .order("id")
        .range(from, to),
    ),
  );
  if (contacts.length === 0) {
    return { percentage: 100, onTrack: 0, total: 0, breakdown: { withCadenceOnTrack: 0, withCadenceOverdue: 0, noCadence: 0, neverContactedPast7d: 0 } };
  }

  const lastTouchMap = await buildLastTouchMap(userId, contacts.map((c) => c.id));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let onTrack = 0;
  let total = 0;
  let withCadenceOnTrack = 0;
  let withCadenceOverdue = 0;
  let noCadence = 0;
  let neverContactedPast7d = 0;

  for (const c of contacts) {
    if (c.first_outreach_skipped) continue;

    const lastTouch = lastTouchMap.get(c.id);
    const hasBeenContacted = !!lastTouch;
    const isRecent = c.created_at >= recentCutoff;

    // Include if: contacted at least once, OR past 7-day window
    if (!hasBeenContacted && isRecent) continue; // Still in Recently Added — skip

    total++;

    if (!hasBeenContacted) {
      // Past 7 days, never contacted
      neverContactedPast7d++;
      if (c.follow_up_frequency_days) {
        // Has cadence — check if overdue from created_at
        const createdDate = new Date(c.created_at);
        const dueDate = new Date(createdDate);
        dueDate.setDate(dueDate.getDate() + c.follow_up_frequency_days);
        if (today <= dueDate) {
          onTrack++;
          withCadenceOnTrack++;
        } else {
          withCadenceOverdue++;
        }
      } else {
        noCadence++;
        // No cadence = not on track
      }
      continue;
    }

    // Has been contacted
    if (!c.follow_up_frequency_days) {
      noCadence++;
      // No cadence = not on track
      continue;
    }

    const lastTouchDate = new Date(lastTouch);
    const daysSince = Math.floor((today.getTime() - lastTouchDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= c.follow_up_frequency_days) {
      onTrack++;
      withCadenceOnTrack++;
    } else {
      withCadenceOverdue++;
    }
  }

  const percentage = total > 0 ? Math.round((onTrack / total) * 100) : 100;

  return {
    percentage,
    onTrack,
    total,
    breakdown: {
      withCadenceOnTrack,
      withCadenceOverdue,
      noCadence,
      neverContactedPast7d,
    },
  };
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
 */
export async function getNeglectedContacts(userId: string) {
  const contacts = await getContactsWithLastTouch(userId);

  return contacts
    .filter((c) => {
      if (!c.follow_up_frequency_days || c.follow_up_frequency_days <= 0) return false;
      if (c.days_since_touch === null) return true; // Never contacted with cadence set
      return c.days_since_touch >= c.follow_up_frequency_days * 2;
    })
    .sort((a, b) => {
      const aRatio = a.days_since_touch !== null && a.follow_up_frequency_days
        ? a.days_since_touch / a.follow_up_frequency_days : 999;
      const bRatio = b.days_since_touch !== null && b.follow_up_frequency_days
        ? b.days_since_touch / b.follow_up_frequency_days : 999;
      return bRatio - aRatio;
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      days_since_touch: c.days_since_touch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    }));
}

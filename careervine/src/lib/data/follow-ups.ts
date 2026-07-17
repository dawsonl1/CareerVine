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
 * Internal to src/lib/data (not re-exported from the queries barrel).
 */
export async function buildLastTouchMap(contactIds: number[]): Promise<Map<number, string>> {
  if (contactIds.length === 0) return new Map();

  const [meetingLinks, interactions] = await Promise.all([
    chunked(contactIds, async (chunk) =>
      must(
        await db()
          .from("meeting_contacts")
          .select("contact_id, meetings(meeting_date)")
          .in("contact_id", chunk),
      ),
    ),
    chunked(contactIds, async (chunk) =>
      must(
        await db()
          .from("interactions")
          .select("contact_id, interaction_date")
          .in("contact_id", chunk),
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

  const lastTouchMap = await buildLastTouchMap(contacts.map((c) => c.id));

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

  const lastTouchMap = await buildLastTouchMap(contacts.map((c) => c.id));

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

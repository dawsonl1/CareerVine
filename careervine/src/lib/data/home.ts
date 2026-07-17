/**
 * Home dashboard aggregate queries (CAR-146 split of queries.ts).
 *
 * getHomeCoreData is the load-bearing fetch (action list + reach-outs +
 * health lookups); the rest are cosmetic widgets (stats, streak, heatmap)
 * that deliberately tolerate read errors — see the error-tolerated
 * annotations. Client resolution is lazy via db().
 */

import { db, must } from "./client";
import { paginateAll } from "./postgrest";
import { buildLastTouchMap, getRecentCutoff } from "./follow-ups";

/**
 * Combined home page data fetch — loads action items + all contact-derived data
 * in minimal queries. Replaces separate calls to getActionItems, getContactsDueForFollowUp,
 * getContactsWithLastTouch, and getRecentUncontactedContacts.
 *
 * Query breakdown:
 * 1. Action items (1 query)
 * 2. All contacts with emails (paginated)
 * 3. Last-touch map from meeting_contacts + interactions (2 queries in parallel)
 */
export async function getHomeCoreData(userId: string) {
  const now = new Date().toISOString();
  const recentCutoff = getRecentCutoff();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch action items + all contacts in parallel. The contacts read
  // paginates (bulk imports push networks past PostgREST's 1000-row cap);
  // name order is kept for downstream display, with id as the tiebreak so
  // page windows stay stable across equal names.
  const [actionItemsResult, allContacts] = await Promise.all([
    db()
      .from("follow_up_action_items")
      .select("*, contacts(*), meetings(*), action_item_contacts(contact_id, contacts(id, name))")
      .eq("user_id", userId)
      .eq("is_completed", false)
      .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
      .order("due_at", { ascending: true, nullsFirst: false }),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("contacts")
          .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, reach_out_snoozed_until, contact_emails(email)")
          .eq("user_id", userId)
          .eq("network_status", "active") // network health + reach-out prompts cover the real network only
          .order("name")
          .order("id")
          .range(from, to),
      ),
    ),
  ]);

  if (actionItemsResult.error) throw actionItemsResult.error;
  const actionItems = actionItemsResult.data || [];
  const contactIds = allContacts.map((c) => c.id);

  // Build last-touch map (2 queries in parallel)
  const lastTouchMap = await buildLastTouchMap(contactIds);

  // ── Derive contactHealth (for lastTouchLookup) ──
  const contactHealth = allContacts.map((c) => {
    const lastTouch = lastTouchMap.get(c.id) || null;
    const daysSinceTouch = lastTouch
      ? Math.floor((today.getTime() - new Date(lastTouch).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    return {
      id: c.id,
      name: c.name,
      days_since_touch: daysSinceTouch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    };
  });

  // ── Derive followUps (reach out contacts) ──
  // Filter snoozed contacts for followUps/recentlyAdded (but not contactHealth)
  const isSnoozed = (c: { reach_out_snoozed_until: string | null }) =>
    c.reach_out_snoozed_until && new Date(c.reach_out_snoozed_until) > new Date(now);

  const followUps = allContacts
    .map((c) => {
      if (isSnoozed(c)) return null;

      const lastTouch = lastTouchMap.get(c.id);
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const freqDays = c.follow_up_frequency_days;
      const neverContacted = !lastTouchDate;
      const noCadence = !freqDays;
      const isRecent = c.created_at >= recentCutoff;

      if (neverContacted && (isRecent || c.first_outreach_skipped)) return null;

      if (noCadence) {
        if (!neverContacted || !isRecent) {
          return {
            id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
            follow_up_frequency_days: 0, last_touch: lastTouch || null,
            days_overdue: 0, never_contacted: neverContacted, no_cadence: true,

            emails: (c.contact_emails || []).map((e) => e.email).filter((email): email is string => email !== null),
          };
        }
        return null;
      }

      let daysOverdue: number;
      if (neverContacted) {
        const dueDate = new Date(c.created_at);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      } else {
        const dueDate = new Date(lastTouchDate);
        dueDate.setDate(dueDate.getDate() + freqDays);
        daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      }
      if (daysOverdue < 0) return null;

      return {
        id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
        follow_up_frequency_days: freqDays, last_touch: lastTouch || null,
        days_overdue: daysOverdue, never_contacted: neverContacted, no_cadence: false,

        emails: (c.contact_emails || []).map((e) => e.email).filter((email): email is string => email !== null),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => {
      if (a.no_cadence && !b.no_cadence) return 1;
      if (!a.no_cadence && b.no_cadence) return -1;
      return b.days_overdue - a.days_overdue;
    });

  // ── Derive recentlyAdded (uncontacted contacts in last 7 days) ──
  const contacted = new Set<number>();
  for (const [id] of lastTouchMap) contacted.add(id);

  const recentlyAdded = allContacts
    .filter((c) => {
      if (isSnoozed(c)) return false;
      if (c.first_outreach_skipped) return false;
      if (c.created_at < recentCutoff) return false;
      if (contacted.has(c.id)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      industry: c.industry,
      created_at: c.created_at,
      emails: (c.contact_emails || []).map((e) => e.email).filter((email): email is string => email !== null),
    }));

  return { actionItems, contactHealth, followUps, recentlyAdded };
}

/**
 * Fast count of action list items — fires first on page load so the calendar
 * can predict its height before the full data loads.
 * Returns: action items (non-waiting_on) + contacts with follow-up frequency
 * (upper bound for reach-out) + recently added uncontacted contacts.
 */
export async function getActionListCounts(userId: string) {
  const cutoff = getRecentCutoff();

  // error-tolerated: these counts only pre-size the action list; a failed
  // count renders as 0 and the real data corrects it moments later.
  const [actionResult, followUpResult, recentResult] = await Promise.all([
    // Count incomplete action items (excluding waiting_on)
    db()
      .from("follow_up_action_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_completed", false)
      .or("direction.is.null,direction.neq.waiting_on"),

    // Upper bound for reach-out: contacts with a follow-up frequency set
    db()
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .not("follow_up_frequency_days", "is", null),

    // Recently added contacts (last 7 days), active network only to match the rendered Recently Added list
    db()
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("network_status", "active")
      .gte("created_at", cutoff),
  ]);

  return {
    actionItems: actionResult.count ?? 0,
    reachOut: followUpResult.count ?? 0,
    recentlyAdded: recentResult.count ?? 0,
  };
}

/**
 * Get the user's current networking streak — consecutive days with at least
 * one activity (meeting logged, action item completed, or interaction).
 * Counts backward from yesterday (today is still in progress).
 */
export async function getNetworkingStreak(userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Look back up to 365 days
  const lookback = new Date(today);
  lookback.setDate(lookback.getDate() - 365);
  const lookbackStr = lookback.toISOString().split("T")[0];

  // Get all activity dates (paginated — a year of activity can pass the
  // 1000-row cap and silently truncate the streak otherwise).
  // error-tolerated: the streak is a cosmetic widget; a failed read renders
  // as a shorter/zero streak rather than an error.
  const [meetings, completedItems, interactions] = await Promise.all([
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("meetings")
          .select("meeting_date")
          .eq("user_id", userId)
          .gte("meeting_date", lookbackStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("follow_up_action_items")
          .select("completed_at")
          .eq("user_id", userId)
          .eq("is_completed", true)
          .gte("completed_at", lookback.toISOString())
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("interactions")
          .select("interaction_date, contacts!inner()")
          .eq("contacts.user_id", userId)
          .gte("interaction_date", lookbackStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
  ]);

  const activeDays = new Set<string>();

  for (const m of meetings) {
    if (m.meeting_date) activeDays.add(m.meeting_date.split("T")[0]);
  }
  for (const a of completedItems) {
    if (a.completed_at) activeDays.add(a.completed_at.split("T")[0]);
  }
  for (const i of interactions) {
    if (i.interaction_date) activeDays.add(i.interaction_date.split("T")[0]);
  }

  // Count consecutive days backward from yesterday
  let streak = 0;
  const checkDate = new Date(today);
  // Include today if there's activity
  const todayStr = today.toISOString().split("T")[0];
  if (activeDays.has(todayStr)) {
    streak = 1;
    checkDate.setDate(checkDate.getDate() - 1);
  } else {
    // Start from yesterday
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const dateStr = checkDate.toISOString().split("T")[0];
    if (activeDays.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return { streak };
}

/**
 * Get aggregated home page stats: rolling 7-day window + previous 7 days for trend comparison.
 */
export async function getHomeStats(userId: string) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const currentStr = sevenDaysAgo.toISOString();
  const previousStr = fourteenDaysAgo.toISOString();

  // error-tolerated: stat tiles render a failed count as 0 rather than
  // failing the whole dashboard.
  const [
    { count: meetingsCurrent },
    { count: meetingsPrevious },
    { count: pendingItems },
    { count: completedCurrent },
    { count: completedPrevious },
    { count: contactsCurrent },
    { count: contactsPrevious },
    { count: interactionsCurrent },
    { count: interactionsPrevious },
    { count: emailsSentCurrent },
    { count: emailsSentPrevious },
  ] = await Promise.all([
    db().from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("meeting_date", currentStr.split("T")[0]),
    db().from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).gte("meeting_date", previousStr.split("T")[0]).lt("meeting_date", currentStr.split("T")[0]),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", false),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", true).gte("completed_at", currentStr),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_completed", true).gte("completed_at", previousStr).lt("completed_at", currentStr),
    // "Contacts added" counts the real network only; imported prospects/bench are not contacts the user added (matches the active-only Recently Added list)
    db().from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("network_status", "active").gte("created_at", currentStr),
    db().from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("network_status", "active").gte("created_at", previousStr).lt("created_at", currentStr),
    db().from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).gte("interaction_date", currentStr.split("T")[0]),
    db().from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).gte("interaction_date", previousStr.split("T")[0]).lt("interaction_date", currentStr.split("T")[0]),
    db().from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "outbound").gte("date", currentStr.split("T")[0]),
    db().from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("direction", "outbound").gte("date", previousStr.split("T")[0]).lt("date", currentStr.split("T")[0]),
  ]);

  return {
    meetings: { current: meetingsCurrent || 0, previous: meetingsPrevious || 0 },
    pendingItems: pendingItems || 0,
    completedItems: { current: completedCurrent || 0, previous: completedPrevious || 0 },
    contactsAdded: { current: contactsCurrent || 0, previous: contactsPrevious || 0 },
    emailsSent: { current: emailsSentCurrent || 0, previous: emailsSentPrevious || 0 },
    touchpoints: { current: (interactionsCurrent || 0) + (meetingsCurrent || 0), previous: (interactionsPrevious || 0) + (meetingsPrevious || 0) },
  };
}

/**
 * Get daily activity counts for the last 4 months for the heatmap.
 * Start date is aligned to the nearest Sunday ~4 months ago, end date is today.
 */
export async function getActivityHeatmap(userId: string) {
  const now = new Date();
  // Go back ~6 months and align to Sunday
  const start = new Date(now);
  start.setMonth(start.getMonth() - 6);
  start.setDate(start.getDate() - start.getDay()); // Align to Sunday
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().split("T")[0];

  // Paginated — a bulk import alone can add >1000 contacts inside the
  // window and silently flatten the heatmap otherwise.
  // error-tolerated: the heatmap is a cosmetic visualization; a failed read
  // renders those days as empty rather than failing the dashboard.
  const [meetings, completedItems, interactions, sentEmails] = await Promise.all([
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("meetings")
          .select("meeting_date")
          .eq("user_id", userId)
          .gte("meeting_date", startStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("follow_up_action_items")
          .select("completed_at")
          .eq("user_id", userId)
          .eq("is_completed", true)
          .gte("completed_at", start.toISOString())
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("interactions")
          .select("interaction_date, contacts!inner()")
          .eq("contacts.user_id", userId)
          .gte("interaction_date", startStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("email_messages")
          .select("date")
          .eq("user_id", userId)
          .eq("direction", "outbound")
          .gte("date", startStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
  ]);

  // Build day map with breakdown by type
  type DayBreakdown = { conversations: number; actions: number; contacts: number };
  const dayMap = new Map<string, DayBreakdown>();
  const getDay = (date: string) => {
    const existing = dayMap.get(date);
    if (existing) return existing;
    const fresh = { conversations: 0, actions: 0, contacts: 0 };
    dayMap.set(date, fresh);
    return fresh;
  };

  for (const m of meetings) {
    const d = m.meeting_date?.split("T")[0];
    if (d) getDay(d).conversations++;
  }
  for (const a of completedItems) {
    const d = a.completed_at?.split("T")[0];
    if (d) getDay(d).actions++;
  }
  for (const e of sentEmails) {
    const d = e.date?.split("T")[0];
    if (d) getDay(d).actions++;
  }
  for (const i of interactions) {
    // interaction_date is timestamptz — trim to the YYYY-MM-DD bucket key
    // like every other source (untrimmed, interactions never matched a day).
    const d = i.interaction_date?.split("T")[0];
    if (d) getDay(d).conversations++;
  }

  // Also count contacts added per day
  // error-tolerated: same cosmetic surface as above.
  const newContacts = await paginateAll(async (from, to) =>
    must(
      await db()
        .from("contacts")
        .select("created_at")
        .eq("user_id", userId)
        .gte("created_at", start.toISOString())
        .order("id")
        .range(from, to),
    ),
  ).catch(() => []);

  for (const c of newContacts) {
    const d = c.created_at?.split("T")[0];
    if (d) getDay(d).contacts++;
  }

  // Helper to format date as YYYY-MM-DD in local timezone (avoids UTC shift)
  const toLocalDateStr = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

  // Build array from start through today (local dates)
  const result: { date: string; count: number; dayOfWeek: number; conversations: number; actions: number; contacts: number }[] = [];
  const todayStr = toLocalDateStr(now);
  const d = new Date(start);
  while (toLocalDateStr(d) <= todayStr) {
    const dateStr = toLocalDateStr(d);
    const breakdown = dayMap.get(dateStr) || { conversations: 0, actions: 0, contacts: 0 };
    result.push({
      date: dateStr,
      count: breakdown.conversations + breakdown.actions + breakdown.contacts,
      dayOfWeek: d.getDay(),
      ...breakdown,
    });
    d.setDate(d.getDate() + 1);
  }

  return result;
}

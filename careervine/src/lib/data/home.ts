/**
 * Home dashboard aggregate queries (CAR-146 split of queries.ts).
 *
 * getHomeCoreData is the load-bearing fetch (action list + reach-outs +
 * health lookups); the rest are cosmetic widgets (stats, streak, heatmap)
 * that deliberately tolerate read errors — see the error-tolerated
 * annotations. Client resolution is lazy via db().
 *
 * ONE fetch per row set, and the dashboard's widgets derive from it
 * (CAR-229). Every band-3 rollup over the active contact list plus its
 * last-touch map — the donut, the neglected list, the on-track ratio — is
 * derived inside getHomeCoreData from the population it already paginated,
 * by calling those rollups' own functions with a PrefetchedContacts instead
 * of letting each re-read the same rows. Same function, same rule, same
 * pinned clock; only the source of the rows differs, so the dashboard and
 * the MCP network-health tool cannot drift apart. A widget that needs a
 * server-side aggregate (getHomeStats, getActionListCounts) keeps one:
 * counting rows in the browser to avoid a request is not the trade.
 *
 * The streak and the heatmap read the same three activity tables, and the
 * streak's 365-day window strictly contains the heatmap's ~6 months, so the
 * dashboard takes both off ONE scan through getHomeActivity — see
 * fetchActivityRows.
 */

import { db, must } from "./client";
import { paginateAll } from "./postgrest";
import {
  buildLastTouchMap,
  getNeglectedContacts,
  getNetworkHealthSummary,
  getRelationshipsOnTrack,
  type PrefetchedContacts,
} from "./follow-ups";
import { getRecentCutoff, startOfDay } from "@/lib/rules/clock";
import { deriveDueFollowUps } from "@/lib/rules/due-follow-ups";
import { deriveNetworkingStreak } from "@/lib/rules/streak";
import { dateKeyOf, daysBetweenDateKeys, toDateKey } from "@/lib/calendar-day";

/**
 * Combined home page data fetch — loads action items + all contact-derived data
 * in minimal queries. Replaces separate calls to getActionItems, getDueFollowUps,
 * getContactsWithLastTouch, and getRecentUncontactedContacts.
 *
 * Query breakdown:
 * 1. Action items (1 query)
 * 2. All contacts with emails (paginated)
 * 3. Last-touch map from meeting_contacts + interactions (2 queries in parallel)
 *
 * Those four reads also back the band-3 rollups (networkHealth,
 * neglectedContacts, relationshipsOnTrack): each is the same pure rule this
 * dashboard has always used, handed the population and the last-touch map
 * already in hand rather than three more copies of them (CAR-229).
 */
export async function getHomeCoreData(userId: string) {
  // One instant for the whole response: contactHealth, followUps and
  // recentlyAdded must not be evaluated against clocks that drifted apart
  // across the awaits between them.
  const now = new Date().toISOString();
  const recentCutoff = getRecentCutoff(now);

  // Fetch action items + all contacts in parallel. The contacts read
  // paginates (bulk imports push networks past PostgREST's 1000-row cap);
  // name order is kept for downstream display, with id as the tiebreak so
  // page windows stay stable across equal names.
  const [actionItems, allContacts] = await Promise.all([
    // Paginated too (CAR-223). Only the contacts leg below was, so an open
    // action-item list past 1000 lost its tail from the home dashboard.
    // id is the tiebreak because due_at is nullable and heavily tied.
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("follow_up_action_items")
          .select("*, contacts(*), meetings(*), action_item_contacts(contact_id, contacts(id, name))")
          .eq("user_id", userId)
          // CAR-260: struck by the user, so it must not count.
          .eq("is_excluded", false)
          .eq("is_completed", false)
          .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
          .order("due_at", { ascending: true, nullsFirst: false })
          .order("id")
          .range(from, to),
      ),
    ),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("contacts")
          .select("id, name, industry, follow_up_frequency_days, photo_url, created_at, first_outreach_skipped, reach_out_snoozed_until, network_status, contact_emails(email)")
          .eq("user_id", userId)
          .eq("network_status", "active") // network health + reach-out prompts cover the real network only (the rule re-enforces this)
          .order("name")
          .order("id")
          .range(from, to),
      ),
    ),
  ]);

  const contactIds = allContacts.map((c) => c.id);

  // Build last-touch map (2 queries in parallel)
  const lastTouchMap = await buildLastTouchMap(userId, contactIds);

  // ── Derive contactHealth (for lastTouchLookup) ──
  const today = startOfDay(now);
  const contactHealth = allContacts.map((c) => {
    const lastTouch = lastTouchMap.get(c.id) || null;
    // Whole calendar days, both ends in the local calendar (CAR-206). The old
    // form divided a millisecond gap between a local midnight and a raw instant,
    // which is off by one at some offsets and across DST.
    const daysSinceTouch = lastTouch
      ? daysBetweenDateKeys(dateKeyOf(new Date(lastTouch)), dateKeyOf(today))
      : null;
    return {
      id: c.id,
      name: c.name,
      days_since_touch: daysSinceTouch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    };
  });

  // ── Derive the band-3 relationship rollups off the same rows ──
  // Same three functions the MCP health tool calls, handed the population and
  // the last-touch map already in hand instead of fetching three more copies
  // of them — nine requests on every dashboard load. No I/O happens here, so
  // these resolve immediately and share the pinned `now` above.
  const prefetched: PrefetchedContacts = { contacts: allContacts, lastTouchMap, nowIso: now };
  const [networkHealth, neglectedContacts, relationshipsOnTrack] = await Promise.all([
    getNetworkHealthSummary(userId, prefetched),
    getNeglectedContacts(userId, prefetched),
    getRelationshipsOnTrack(userId, prefetched),
  ]);

  // ── Derive followUps (reach out contacts) ──
  // Shared rule (CAR-155): the same policy backs the standalone
  // getDueFollowUps fetch and the MCP list_due_followups tool.
  const followUps = deriveDueFollowUps(allContacts, lastTouchMap, now);

  // Filter snoozed contacts for recentlyAdded (but not contactHealth)
  const isSnoozed = (c: { reach_out_snoozed_until: string | null }) =>
    c.reach_out_snoozed_until && new Date(c.reach_out_snoozed_until) > new Date(now);

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

  return {
    actionItems,
    contactHealth,
    followUps,
    recentlyAdded,
    networkHealth,
    neglectedContacts,
    relationshipsOnTrack,
  };
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
      // CAR-260: struck by the user, so it must not count.
      .eq("is_excluded", false)
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

/** How far back the streak walk can reach. */
const STREAK_LOOKBACK_DAYS = 365;

/** The three activity tables both the streak and the heatmap read. */
interface ActivityRows {
  meetings: { meeting_date: string | null }[];
  completedItems: { completed_at: string | null }[];
  interactions: { interaction_date: string | null }[];
}

/**
 * The three activity legs, shared by getNetworkingStreak and
 * getActivityHeatmap so the two cannot drift in shape or scoping.
 *
 * ONE scan serves both on a dashboard load (CAR-229). The streak's window (365
 * days) strictly contains the heatmap's (~6 months), so getHomeActivity runs
 * this once over the wider window and hands the rows to the heatmap as
 * PrefetchedActivity; rows older than the heatmap's start bucket into days its
 * axis never emits, so the wider window costs it nothing but the rows. The two
 * standalone entry points keep their own scans for callers holding nothing —
 * the MCP network-health tool is getNetworkingStreak's.
 *
 * Paginated — a year of activity can pass the 1000-row cap and silently
 * truncate the streak otherwise.
 *
 * error-tolerated: the streak and the heatmap are cosmetic widgets; a failed
 * read renders as a shorter/zero streak and empty days rather than an error.
 */
function fetchActivityRows(userId: string, since: Date): Promise<ActivityRows> {
  const sinceDay = since.toISOString().split("T")[0];
  return Promise.all([
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("meetings")
          .select("meeting_date")
          .eq("user_id", userId)
          .eq("is_excluded", false)
          .gte("meeting_date", sinceDay)
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
          .eq("is_excluded", false)
          .eq("is_completed", true)
          .gte("completed_at", since.toISOString())
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
          .eq("is_excluded", false)
          .gte("interaction_date", sinceDay)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
  ]).then(([meetings, completedItems, interactions]) => ({ meetings, completedItems, interactions }));
}

/**
 * Local calendar day of each activity, matching the basis deriveNetworkingStreak
 * compares against (CAR-206). Splitting on "T" gave the UTC day, so an evening
 * meeting west of UTC landed on tomorrow's key and never counted for the day
 * it happened. meeting_date is a naive wall clock stored as UTC, so its own
 * digits are the local day the user meant; the other two are real instants.
 *
 * Deliberately NOT the heatmap's bucket key: that one is the stored date part
 * (the axis the user reads), this one is the viewer's calendar day.
 */
function streakDayKeys(rows: ActivityRows): Set<string> {
  const activeDays = new Set<string>();
  for (const m of rows.meetings) {
    if (m.meeting_date) activeDays.add(toDateKey(m.meeting_date) ?? "");
  }
  for (const a of rows.completedItems) {
    if (a.completed_at) activeDays.add(dateKeyOf(new Date(a.completed_at)));
  }
  for (const i of rows.interactions) {
    if (i.interaction_date) activeDays.add(dateKeyOf(new Date(i.interaction_date)));
  }
  activeDays.delete("");
  return activeDays;
}

/**
 * Get the user's current networking streak — consecutive days with at least
 * one activity (meeting logged, action item completed, or interaction).
 * Counts backward from yesterday (today is still in progress).
 *
 * Standalone fetch for callers holding nothing (the MCP network-health tool).
 * The dashboard takes its streak off getHomeActivity's scan instead, since
 * the heatmap reads the same three tables over a narrower window (CAR-229).
 */
export async function getNetworkingStreak(userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const lookback = new Date(today);
  lookback.setDate(lookback.getDate() - STREAK_LOOKBACK_DAYS);

  const rows = await fetchActivityRows(userId, lookback);

  // Counting policy lives in src/lib/rules/streak.ts (CAR-155).
  return { streak: deriveNetworkingStreak(streakDayKeys(rows), today.toISOString()) };
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
    db().from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).gte("meeting_date", currentStr.split("T")[0]),
    db().from("meetings").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).gte("meeting_date", previousStr.split("T")[0]).lt("meeting_date", currentStr.split("T")[0]),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).eq("is_completed", false),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).eq("is_completed", true).gte("completed_at", currentStr),
    db().from("follow_up_action_items").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).eq("is_completed", true).gte("completed_at", previousStr).lt("completed_at", currentStr),
    // "Contacts added" counts the real network only; imported prospects/bench are not contacts the user added (matches the active-only Recently Added list)
    db().from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("network_status", "active").gte("created_at", currentStr),
    db().from("contacts").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("network_status", "active").gte("created_at", previousStr).lt("created_at", currentStr),
    db().from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).eq("is_excluded", false).gte("interaction_date", currentStr.split("T")[0]),
    db().from("interactions").select("*, contacts!inner()", { count: "exact", head: true }).eq("contacts.user_id", userId).eq("is_excluded", false).gte("interaction_date", previousStr.split("T")[0]).lt("interaction_date", currentStr.split("T")[0]),
    db().from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).eq("direction", "outbound").gte("date", currentStr.split("T")[0]),
    db().from("email_messages").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_excluded", false).eq("direction", "outbound").gte("date", previousStr.split("T")[0]).lt("date", currentStr.split("T")[0]),
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
 * Activity rows a caller already has in flight, so the heatmap does not
 * re-read them (CAR-229).
 *
 * `rows` may be a PROMISE deliberately: getHomeActivity starts the shared scan
 * and the heatmap's own two legs in the same tick, so all five requests are
 * one round trip rather than two.
 *
 * `now` is the caller's pinned instant, so the heatmap's axis and the streak
 * derived beside it off the same rows cannot straddle two clocks.
 */
interface PrefetchedActivity {
  rows: ActivityRows | Promise<ActivityRows>;
  now: Date;
}

/**
 * Get daily activity counts for the last ~6 months for the heatmap.
 * Start date is aligned to the nearest Sunday ~6 months ago, end date is today.
 *
 * Standalone fetch for callers holding nothing. The dashboard passes
 * PrefetchedActivity instead, because the streak scans the same three tables
 * over a strictly wider window — same function, same day arithmetic, only the
 * source of the activity rows differs (CAR-229, getHomeActivity).
 *
 * The email_messages and contacts sweeps below are keyed by THIS function's
 * name in check-conventions' EXHAUSTIVE_SWEEP_ALLOWLIST, so lifting either
 * into a helper renames its entry and fails that ratchet in both directions.
 */
export async function getActivityHeatmap(userId: string, prefetched?: PrefetchedActivity) {
  const now = prefetched?.now ?? new Date();
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
  const [activity, sentEmails, newContacts] = await Promise.all([
    prefetched?.rows ?? fetchActivityRows(userId, start),
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("email_messages")
          .select("date")
          .eq("user_id", userId)
          .eq("is_excluded", false)
          .eq("direction", "outbound")
          .gte("date", startStr)
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
    // Contacts added per day. In the same batch as its siblings, not awaited
    // after them: it depends on nothing above and a serial read here was a
    // second round trip on every dashboard load.
    paginateAll(async (from, to) =>
      must(
        await db()
          .from("contacts")
          .select("created_at")
          .eq("user_id", userId)
          .gte("created_at", start.toISOString())
          .order("id")
          .range(from, to),
      ),
    ).catch(() => []),
  ]);
  const { meetings, completedItems, interactions } = activity;

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

/**
 * The dashboard's activity band: heatmap plus streak off ONE scan of the three
 * activity tables (CAR-229).
 *
 * They read the same tables and the streak's 365-day window strictly contains
 * the heatmap's ~6 months, so the wider scan serves both and the pair costs 5
 * requests instead of 8. Neither result is re-derived here: the day array is
 * getActivityHeatmap's own, and the streak is deriveNetworkingStreak over this
 * module's day keys — the same rule and the same input getNetworkingStreak
 * hands it, differing only in where the rows came from.
 *
 * ONE pinned `now` for the whole response, like getHomeCoreData: the streak's
 * day walk and the heatmap's axis are two views of one instant and must not be
 * evaluated against clocks that drifted across the awaits between them.
 */
export async function getHomeActivity(userId: string) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const lookback = new Date(today);
  lookback.setDate(lookback.getDate() - STREAK_LOOKBACK_DAYS);

  // Deliberately not awaited before the heatmap call: passing the promise lets
  // the heatmap's own two legs go out in the same tick as these three, so the
  // consolidation saves three requests without adding a round trip.
  const rows = fetchActivityRows(userId, lookback);
  const heatmap = await getActivityHeatmap(userId, { rows, now });

  // Counting policy lives in src/lib/rules/streak.ts (CAR-155).
  return { heatmap, streak: deriveNetworkingStreak(streakDayKeys(await rows), today.toISOString()) };
}

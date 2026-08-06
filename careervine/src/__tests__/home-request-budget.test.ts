/**
 * Dashboard request budget + rollup equivalence (CAR-229).
 *
 * The home page was issuing ~50 network requests on load, not because any one
 * read was large but because seven widgets each fetched an overlapping slice
 * of the same rows: `contacts` eleven times, `follow_up_action_items` seven,
 * `interactions` seven. Four of those cycles were the SAME population — the
 * active contact list plus its last-touch map — re-read by the reach-out feed,
 * the donut, the neglected list and the on-track ratio. A fifth was the streak
 * and the heatmap scanning the same three activity tables separately, which
 * getHomeActivity now does once over the wider of the two windows.
 *
 * Two things are pinned here, and they are load-bearing in opposite
 * directions:
 *
 *   1. BUDGET — the per-table query count of a cold dashboard load, driven
 *      through the real setDataClient seam against the recording client with a
 *      NON-EMPTY fixture. Non-empty matters: the sibling registry in
 *      data-query-shapes.test.ts drives every function with zero rows, so
 *      buildLastTouchMap's two legs never fire there and its pins cannot see
 *      the duplication this ticket removed. A widget that starts re-reading a
 *      table fails this test with the table named.
 *
 *   2. EQUIVALENCE — the rollups getHomeCoreData now derives are identical,
 *      value for value, to what their standalone fetch wrappers return over
 *      the same data. That is what makes the budget cut safe: the dashboard is
 *      calling the same functions over the same rules, only with the rows it
 *      already holds. Consolidation that changed a number would fail here
 *      rather than silently shipping a different donut.
 *
 * The fixture is deliberately non-degenerate — healthy, overdue, never
 * contacted and no-cadence contacts are all present — so neither half can pass
 * vacuously over empty output. The final assertions in the equivalence block
 * exist to prove exactly that.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
} from "../mcp/__tests__/helpers/recording-client";
import { setDataClient, type QueryClient } from "@/lib/data/client";
import {
  getNeglectedContacts,
  getNetworkHealthSummary,
  getRelationshipsOnTrack,
} from "@/lib/data/follow-ups";
import {
  getActionListCounts,
  getActivityHeatmap,
  getHomeActivity,
  getHomeCoreData,
  getHomeStats,
  getNetworkingStreak,
} from "@/lib/data/home";
import { dateKeyOf } from "@/lib/calendar-day";
import { getContactEmailLookup } from "@/lib/data/contacts";
import { getDismissedGettingStarted } from "@/lib/data/users";

const USER = "user-1";
const state = createRecordingState();

// Noon UTC keeps every fixture instant on the same calendar day for any zone
// within ±12h, so "5 days ago" is 5 days ago on the runner as well as in CI.
const NOW = new Date("2026-08-05T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ── Fixture ────────────────────────────────────────────────────────────
// Four contacts spanning every donut bucket, so a rollup that silently
// collapsed to zeros could not pass the equivalence assertions below.

const CONTACTS = [
  // Healthy: 5 days into a 30-day cadence.
  { id: 1, name: "Alice", industry: "Tech", follow_up_frequency_days: 30, photo_url: null,
    created_at: "2025-01-01T00:00:00.000Z", first_outreach_skipped: false,
    reach_out_snoozed_until: null, network_status: "active", contact_emails: [{ email: "alice@example.com" }] },
  // Overdue and neglected: 40 days into a 7-day cadence.
  { id: 2, name: "Bob", industry: null, follow_up_frequency_days: 7, photo_url: null,
    created_at: "2025-01-01T00:00:00.000Z", first_outreach_skipped: false,
    reach_out_snoozed_until: null, network_status: "active", contact_emails: [] },
  // Never contacted, well past the Recently Added window.
  { id: 3, name: "Cara", industry: null, follow_up_frequency_days: 30, photo_url: null,
    created_at: "2025-01-01T00:00:00.000Z", first_outreach_skipped: false,
    reach_out_snoozed_until: null, network_status: "active", contact_emails: [] },
  // Contacted, no cadence set.
  { id: 4, name: "Dan", industry: null, follow_up_frequency_days: null, photo_url: null,
    created_at: "2025-01-01T00:00:00.000Z", first_outreach_skipped: false,
    reach_out_snoozed_until: null, network_status: "active", contact_emails: [] },
];

// Alice's last touch is a meeting; Bob's and Dan's are interactions. Both legs
// of buildLastTouchMap therefore carry rows, so neither can be dropped without
// changing the fixture's output.
const MEETING_LINKS = [{ contact_id: 1, meetings: { meeting_date: daysAgo(5) } }];
const INTERACTIONS = [
  { contact_id: 2, interaction_date: daysAgo(40) },
  { contact_id: 4, interaction_date: daysAgo(10) },
];
const ACTION_ITEMS = [
  { id: 11, user_id: USER, title: "Send deck", description: null, is_completed: false,
    due_at: daysAgo(1), completed_at: null, direction: "my_task", source: null,
    snoozed_until: null, contacts: null, meetings: null, action_item_contacts: [] },
];

// The activity scan's own rows. Read ONLY by the streak/heatmap legs — every
// other meetings read on this page is a head count — so these perturb nothing
// above. Two consecutive recent days give the streak a real run to walk, and
// the 300-day-old one sits inside the streak's 365-day window but outside the
// heatmap's ~6 months, which is what makes the shared scan falsifiable in both
// directions.
const MEETINGS = [{ meeting_date: daysAgo(1) }, { meeting_date: daysAgo(2) }, { meeting_date: daysAgo(300) }];

function route(q: RecordedQuery): unknown | undefined {
  // Head counts resolve through the recorder's default (count 0); only row
  // reads need fixtures.
  if (q.headRequested) return undefined;
  switch (q.table) {
    case "contacts":
      return CONTACTS;
    case "meeting_contacts":
      return MEETING_LINKS;
    case "meetings":
      return MEETINGS;
    case "interactions":
      return INTERACTIONS;
    case "follow_up_action_items":
      return ACTION_ITEMS;
    case "contact_emails":
      return [{ email: "alice@example.com", contact_id: 1, contacts: { id: 1, name: "Alice", photo_url: null, user_id: USER } }];
    case "users":
      return { dismissed_getting_started: [] };
    default:
      return undefined;
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  state.recorded.length = 0;
  state.route = route;
  setDataClient(createRecordingClient(state) as unknown as QueryClient);
});

// The seam is a module-global singleton — restore the browser fallback so
// suites sharing this worker never see the recorder.
afterAll(() => {
  setDataClient(null);
  vi.useRealTimers();
});

function countsByTable(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of state.recorded) out[q.table] = (out[q.table] ?? 0) + 1;
  return out;
}

// ── 1. Budget ──────────────────────────────────────────────────────────

/**
 * Exactly what src/app/page.tsx calls through the data layer on a cold load:
 * loadCounts + loadCoreData + loadBand3, the getting-started read, and the
 * contact lookup loadSchedule makes once the calendar is connected.
 */
async function driveDashboardLoad() {
  await Promise.all([
    getActionListCounts(USER),
    getHomeCoreData(USER),
    getHomeStats(USER),
    getHomeActivity(USER),
    getDismissedGettingStarted(USER),
    getContactEmailLookup(USER),
  ]);
}

describe("dashboard request budget (CAR-229)", () => {
  it("issues the pinned number of queries per table", async () => {
    await driveDashboardLoad();

    // Raising any number here is a real regression in what the landing page
    // costs on a high-latency connection. If a widget genuinely needs another
    // read, change the number in the same commit and say why in the PR.
    // 25 queries, from 37 before this ticket. The per-loader breakdown in the
    // next test is where each number comes from.
    expect(countsByTable()).toEqual({
      contacts: 6,
      follow_up_action_items: 6,
      interactions: 4,
      meetings: 3,
      meeting_contacts: 1,
      email_messages: 3,
      contact_emails: 1,
      users: 1,
    });
    expect(state.recorded).toHaveLength(25);
  });

  it("attributes the budget to the loaders that spend it", async () => {
    const perLoader: Record<string, Record<string, number>> = {};
    for (const [name, drive] of Object.entries({
      getActionListCounts: () => getActionListCounts(USER),
      getHomeCoreData: () => getHomeCoreData(USER),
      getHomeStats: () => getHomeStats(USER),
      getHomeActivity: () => getHomeActivity(USER),
    })) {
      state.recorded.length = 0;
      await drive();
      perLoader[name] = countsByTable();
    }

    expect(perLoader).toEqual({
      // 2 contacts head counts + 1 action-items head count.
      getActionListCounts: { contacts: 2, follow_up_action_items: 1 },
      // The consolidated read: action items + contacts + the two last-touch
      // legs. The donut, the neglected list and the on-track ratio derive from
      // these four and add NOTHING — they used to add nine.
      getHomeCoreData: { follow_up_action_items: 1, contacts: 1, meeting_contacts: 1, interactions: 1 },
      // Server-side aggregates, deliberately left as counts: pulling these rows
      // into the browser to count them there is not the trade this ticket makes.
      getHomeStats: { meetings: 2, follow_up_action_items: 3, contacts: 2, interactions: 2, email_messages: 2 },
      // The heatmap's five reads, serving the streak as well: the three
      // activity legs are ONE scan over the streak's wider window, and the
      // streak adds nothing of its own. It used to add three.
      getHomeActivity: { meetings: 1, follow_up_action_items: 1, interactions: 1, email_messages: 1, contacts: 1 },
    });
  });

  it("reads the active contact population exactly once for all of band 3", async () => {
    await getHomeCoreData(USER);

    // The row reads (not the head counts) over the population and its touches.
    const rowReads = state.recorded.filter((q) => !q.headRequested);
    expect(rowReads.filter((q) => q.table === "contacts")).toHaveLength(1);
    expect(rowReads.filter((q) => q.table === "meeting_contacts")).toHaveLength(1);
    expect(rowReads.filter((q) => q.table === "interactions")).toHaveLength(1);
  });
});

// ── 2. Equivalence ─────────────────────────────────────────────────────

describe("consolidated rollups equal their standalone fetches (CAR-229)", () => {
  it("derives the same networkHealth, neglectedContacts and relationshipsOnTrack", async () => {
    const core = await getHomeCoreData(USER);

    const [health, neglected, onTrack] = await Promise.all([
      getNetworkHealthSummary(USER),
      getNeglectedContacts(USER),
      getRelationshipsOnTrack(USER),
    ]);

    expect(core.networkHealth).toEqual(health);
    expect(core.neglectedContacts).toEqual(neglected);
    expect(core.relationshipsOnTrack).toEqual(onTrack);

    // Falsification: the three assertions above would also pass if every
    // rollup returned nothing. Pin the fixture's actual shape so they cannot.
    expect(health).toEqual({ healthy: 1, dueSoon: 0, overdue: 1, neverContacted: 1, noCadence: 1, total: 4 });
    // Cara (never contacted) sorts above Bob (5.7x his cadence) — the rule
    // ranks a never-contacted person at the top of the worst-first order.
    expect(neglected.map((c) => c.id)).toEqual([3, 2]);
    expect(onTrack.total).toBe(4);
    expect(onTrack.onTrack).toBe(1);
  });

  it("keeps contactHealth's days_since_touch on the same basis as the health grid", async () => {
    const core = await getHomeCoreData(USER);
    const neglected = await getNeglectedContacts(USER);

    // Bob is the one contact present in both surfaces with a real last touch;
    // the two must agree on how many days ago it was, or the reach-out feed and
    // the neglected list would be measuring different things.
    const bobCore = core.contactHealth.find((c) => c.id === 2);
    const bobNeglected = neglected.find((c) => c.id === 2);
    expect(bobCore?.days_since_touch).toBe(40);
    expect(bobNeglected?.days_since_touch).toBe(40);

    // Never contacted stays null rather than collapsing to 0 (which would read
    // as "contacted today" and drop Cara out of the neglected list).
    expect(core.contactHealth.find((c) => c.id === 3)?.days_since_touch).toBeNull();
  });

  it("pins every rollup to getHomeCoreData's single clock", async () => {
    // The response pins ONE `now` so contactHealth, followUps and the rollups
    // cannot be evaluated against clocks that drifted across the awaits between
    // them. Advancing the clock mid-response is not expressible here, so the
    // guard is that a second call at a later instant on the SAME day is
    // identical: every surface reads the same day boundary, not wall time.
    const first = await getHomeCoreData(USER);
    vi.setSystemTime(new Date(NOW.getTime() + 6 * 3_600_000));
    const later = await getHomeCoreData(USER);

    expect(later.contactHealth).toEqual(first.contactHealth);
    expect(later.networkHealth).toEqual(first.networkHealth);
    expect(later.neglectedContacts).toEqual(first.neglectedContacts);
    expect(later.relationshipsOnTrack).toEqual(first.relationshipsOnTrack);
    expect(later.followUps).toEqual(first.followUps);
  });
});

// ── 3. One activity scan for two widgets ───────────────────────────────

/** The heatmap buckets a stored value by its date part; the fixtures are noon UTC. */
const dayKey = (n: number) => daysAgo(n).split("T")[0];

/** The lower bound of the most recent row read on `table`. */
function sinceOf(table: string, column: string): string {
  const q = state.recorded.filter((r) => r.table === table && !r.headRequested).at(-1)!;
  return q.filters.find(([m, col]) => m === "gte" && col === column)![2] as string;
}

describe("one activity scan serves both the streak and the heatmap (CAR-229)", () => {
  it("derives the same heatmap and streak the standalone fetches do", async () => {
    const activity = await getHomeActivity(USER);

    const [heatmap, streak] = await Promise.all([
      getActivityHeatmap(USER),
      getNetworkingStreak(USER),
    ]);

    expect(activity.heatmap).toEqual(heatmap);
    expect(activity.streak).toBe(streak.streak);

    // Falsification: the two assertions above would also pass if the shared
    // scan produced an empty axis and a zero streak. Pin the fixture's actual
    // activity so they cannot — two meetings and two interactions on the axis,
    // and two consecutive days behind the streak walk.
    const busy = Object.fromEntries(activity.heatmap.filter((d) => d.count > 0).map((d) => [d.date, d.count]));
    expect(busy).toEqual({ [dayKey(1)]: 1, [dayKey(2)]: 1, [dayKey(10)]: 1, [dayKey(40)]: 1 });
    expect(activity.streak).toBe(2);
  });

  it("scans over the streak's 365-day window, not the heatmap's six months", async () => {
    await getHomeActivity(USER);
    const shared = sinceOf("meetings", "meeting_date");

    state.recorded.length = 0;
    await getActivityHeatmap(USER);
    const heatmapOnly = sinceOf("meetings", "meeting_date");

    // Sharing one scan has to widen it to the streak's window, never narrow
    // the streak to the heatmap's — that direction would silently cap a streak
    // at six months and no fixture inside the window could show it.
    expect(shared < heatmapOnly).toBe(true);
    expect(Math.round((NOW.getTime() - new Date(shared).getTime()) / 86_400_000)).toBeGreaterThanOrEqual(365);
  });

  it("keeps the wider scan's older rows off the heatmap's axis", async () => {
    const { heatmap } = await getHomeActivity(USER);

    // The 300-day-old meeting is inside the streak's window and outside the
    // heatmap's. The axis runs from the heatmap's own start through today, so
    // the extra rows the shared scan drags in bucket into days nobody reads.
    expect(heatmap.some((d) => d.date === dayKey(300))).toBe(false);
    expect(heatmap[0].date > dayKey(300)).toBe(true);
    expect(heatmap.reduce((n, d) => n + d.count, 0)).toBe(4);
  });

  it("uses the caller's prefetched rows and pinned instant instead of its own", async () => {
    // What makes the consolidation safe: the heatmap must not re-scan the
    // three activity tables, and must draw its axis on the instant its caller
    // pinned rather than reading the clock again after the awaits.
    const pinned = new Date(NOW.getTime() - 7 * 86_400_000);
    const days = await getActivityHeatmap(USER, {
      rows: { meetings: [], completedItems: [], interactions: [] },
      now: pinned,
    });

    expect(state.recorded.map((q) => q.table).sort()).toEqual(["contacts", "email_messages"]);
    expect(days.at(-1)!.date).toBe(dateKeyOf(pinned));
    expect(days.at(-1)!.date).not.toBe(dateKeyOf(NOW));
  });
});

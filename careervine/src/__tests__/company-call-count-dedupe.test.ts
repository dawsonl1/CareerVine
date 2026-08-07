/**
 * One conversation counts once, however many legs reach it (CAR-250).
 *
 * Production symptom: Adobe's chip read "3 Calls Scheduled" against two real
 * conversations. The Aug 14 call existed as BOTH `calendar_events` 502 (google
 * id `cmk1...`) and `meetings` 24 (`calendar_event_id = cmk1...`), and the two
 * landed under different keys — `cal:502` and `mtg:24` — so a synced call was
 * counted twice.
 *
 * It reads like a former-employee leak, and was reported as one, but the
 * current/former filter was doing its job: the actual former Adobe employee on
 * that card was already excluded. The count itself was inflated. The
 * former-employee case is asserted here too, so a future fix aimed at the
 * reported symptom cannot quietly break what was already right.
 *
 * `call_scheduled` and `call_done` deliberately carry EVENT counts rather than
 * people counts (CAR-246), which is exactly why a duplicated event is visible
 * to the user instead of collapsing silently.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "@/mcp/__tests__/helpers/recording-client";
import { getCompanies, setCompanyQueriesClient, type CompanySummary } from "@/lib/company-queries";

const USER = "user-dedupe";

/** The Adobe shape: one synced call reachable through all three legs. */
const MIRRORED = 61;
/** A meeting with no calendar event behind it — must still count on its own. */
const STANDALONE = 62;
/** The call belongs to someone who has left; it must not count at all. */
const FORMER = 63;

const GOOGLE_ID = "cmk1jdjkdsv85ctgbnl7b7fi10";
/** Far future so these are always "upcoming" regardless of when the suite runs. */
const EVENT_AT = "2099-08-14T17:00:00+00:00";
/** The same conversation as EVENT_AT, stored as a naive wall clock (CAR-206). */
const MEETING_AT = "2099-08-14T11:00:00+00:00";
const STANDALONE_AT = "2099-09-01T15:00:00+00:00";

interface Emp {
  company_id: number;
  contact_id: number;
  is_current: boolean;
}

const employment: Emp[] = [
  { company_id: MIRRORED, contact_id: 701, is_current: true },
  { company_id: STANDALONE, contact_id: 702, is_current: true },
  { company_id: FORMER, contact_id: 703, is_current: false },
];

const COMPANY_IDS = [MIRRORED, STANDALONE, FORMER];

const idsIn = (q: RecordedQuery, col: string): number[] | null => {
  const f = q.filters.find(([m, c]) => m === "in" && c === col);
  return f ? (f[2] as number[]) : null;
};

function route(q: RecordedQuery): unknown | undefined {
  switch (q.table) {
    case "users":
      return { university: "BYU" };

    case "target_companies":
      return COMPANY_IDS.map((company_id, i) => ({
        id: 900 + i,
        company_id,
        location_id: null,
        is_targeted: true,
        priority_score: 10 - i,
        tier: "A",
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "researching",
        locations: null,
      }));

    case "rpc:company_network_counts":
      return COMPANY_IDS.map((company_id) => {
        const mine = employment.filter((e) => e.company_id === company_id);
        return {
          company_id,
          current_count: mine.filter((e) => e.is_current).length,
          former_count: mine.filter((e) => !e.is_current).length,
          bench_count: 0,
          current_prospect_count: mine.filter((e) => e.is_current).length,
        };
      });

    case "companies":
      return (idsIn(q, "id") ?? []).map((id) => ({
        id,
        name: `Company ${id}`,
        logo_url: null,
        linkedin_url: null,
      }));

    case "contact_companies": {
      const set = new Set(idsIn(q, "company_id") ?? []);
      return employment
        .filter((r) => set.has(r.company_id))
        .map((r) => ({
          company_id: r.company_id,
          contact_id: r.contact_id,
          is_current: r.is_current,
          contacts: {
            name: `Person ${r.contact_id}`,
            network_status: "prospect",
            stage_override: null,
            persona: "product_peer",
            verified_school: null,
          },
        }));
    }

    // Leg 1: the event's own contact_id column.
    case "calendar_events": {
      const set = new Set(idsIn(q, "contact_id") ?? []);
      const rows: unknown[] = [];
      if (set.has(701)) {
        rows.push({ id: 502, google_event_id: GOOGLE_ID, contact_id: 701, start_at: EVENT_AT, status: "confirmed" });
      }
      if (set.has(703)) {
        rows.push({ id: 518, google_event_id: "former-google-id", contact_id: 703, start_at: EVENT_AT, status: "confirmed" });
      }
      return rows;
    }

    // Leg 2: the junction. The SAME event as leg 1, which CAR-246 already deduped.
    case "calendar_event_contacts": {
      const set = new Set(idsIn(q, "contact_id") ?? []);
      return set.has(701)
        ? [{
            calendar_event_id: 502,
            contact_id: 701,
            calendar_events: { user_id: USER, google_event_id: GOOGLE_ID, start_at: EVENT_AT, status: "confirmed" },
          }]
        : [];
    }

    // Leg 3: the meeting mirroring that same google event — the CAR-250 leak.
    case "meeting_contacts": {
      const set = new Set(idsIn(q, "contact_id") ?? []);
      const rows: unknown[] = [];
      if (set.has(701)) {
        rows.push({
          meeting_id: 24,
          contact_id: 701,
          meetings: { user_id: USER, meeting_date: MEETING_AT, calendar_event_id: GOOGLE_ID },
        });
      }
      if (set.has(702)) {
        rows.push({
          meeting_id: 25,
          contact_id: 702,
          meetings: { user_id: USER, meeting_date: STANDALONE_AT, calendar_event_id: null },
        });
      }
      return rows;
    }

    case "contact_schools":
    case "contact_emails":
    case "interactions":
    case "referrals":
    case "email_message_contacts":
      return [];

    default:
      return undefined;
  }
}

let state: RecordingState;

beforeEach(() => {
  state = createRecordingState();
  state.route = route;
  setCompanyQueriesClient(createRecordingClient(state) as never);
});

async function summaries(): Promise<Map<number, CompanySummary>> {
  const rows = (await getCompanies(USER, { scope: "targets", sort: "priority" })) as CompanySummary[];
  return new Map(rows.map((r) => [r.id, r]));
}

describe("call counts collapse a meeting onto the calendar event it mirrors (CAR-250)", () => {
  it("counts one conversation once even though three legs reach it", async () => {
    const c = (await summaries()).get(MIRRORED)!;
    expect(c.traction).toBe("call_scheduled");
    // The bug reported 2 here (cal:502 + mtg:24). On the real Adobe card that
    // was the difference between "3 Calls Scheduled" and the truth.
    expect(c.traction_detail?.count).toBe(1);
  });

  it("reports the calendar event's timestamp, not the meeting's naive wall clock", async () => {
    const c = (await summaries()).get(MIRRORED)!;
    // meeting_date is a naive wall clock stored as UTC (CAR-206), so it differs
    // from the real event time by the author's offset. Only the timestamptz can
    // be compared against `now`, so it must be the one that survives the merge.
    expect(c.traction_detail?.at).toBe(EVENT_AT);
  });

  it("still counts a meeting that mirrors no calendar event", async () => {
    const c = (await summaries()).get(STANDALONE)!;
    // Guards against over-collapsing: most meetings carry no calendar_event_id
    // (14 of 23 in prod at the time of the fix) and must keep their own key.
    expect(c.traction).toBe("call_scheduled");
    expect(c.traction_detail?.count).toBe(1);
  });

  it("does not count a call with someone who has left the company", async () => {
    const c = (await summaries()).get(FORMER)!;
    // The reported cause of the Adobe bug. It was already correct (CAR-244 /
    // CAR-246) and is asserted so a fix aimed at the reported symptom cannot
    // regress it.
    expect(c.traction).toBeNull();
    expect(c.traction_detail).toBeNull();
  });
});

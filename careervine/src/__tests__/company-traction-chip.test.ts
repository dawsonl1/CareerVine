/**
 * The traction chip's count + recency (CAR-246).
 *
 * The chip used to render a bare stage label, so the aggregation only ever had
 * to answer "does this company have any of X". Counting makes several
 * previously-harmless behaviors load-bearing, and each test below pins one:
 *
 *  - the two calendar legs can deliver the SAME event for the same contact, so
 *    counting without deduping reports one call as two;
 *  - email states count PEOPLE while call states count EVENTS, on purpose;
 *  - a `stage_override` produces a stage with no evidence behind it, which must
 *    render as a bare label rather than "0 Replies";
 *  - upcoming calls report the soonest, not the latest.
 *
 * Timestamps are deliberately far from today (2020 for past, 2030 for upcoming)
 * because `getContactStages` splits on the real clock. Assertions are on the raw
 * ISO values, never on formatted output, so nothing here rots with the calendar.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "@/mcp/__tests__/helpers/recording-client";
import { getCompanies, setCompanyQueriesClient, type CompanySummary } from "@/lib/company-queries";
import { nextActionForCompany } from "@/lib/company-next-action";

const USER = "user-chip";

const CONTACTED = 10; // three current people emailed, nobody wrote back
const REPLIED = 11; // one of three replied
const CALLS_DONE = 12; // one past call, two attendees, reaching one of them twice
const CALLS_UPCOMING = 13; // two future calls for one person
const OVERRIDE = 14; // stage_override with no underlying event
const FORMER_ONLY = 15; // the only person with history has left
const TWO_REPLIERS = 16; // two people replied; the first one seen is already answered

const PAST = "2020-03-05T17:00:00Z";
const OLDER = "2020-01-02T17:00:00Z";
const SOON = "2030-02-01T17:00:00Z";
const MID = "2030-04-01T17:00:00Z";
const LATER = "2030-06-01T17:00:00Z";

interface Person {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  stage_override?: string | null;
}

const people: Person[] = [
  { company_id: CONTACTED, contact_id: 101, is_current: true },
  { company_id: CONTACTED, contact_id: 102, is_current: true },
  { company_id: CONTACTED, contact_id: 103, is_current: true },
  { company_id: REPLIED, contact_id: 201, is_current: true },
  { company_id: REPLIED, contact_id: 202, is_current: true },
  { company_id: CALLS_DONE, contact_id: 301, is_current: true },
  { company_id: CALLS_DONE, contact_id: 302, is_current: true },
  { company_id: CALLS_UPCOMING, contact_id: 401, is_current: true },
  { company_id: CALLS_UPCOMING, contact_id: 402, is_current: true },
  { company_id: OVERRIDE, contact_id: 501, is_current: true, stage_override: "replied" },
  { company_id: FORMER_ONLY, contact_id: 601, is_current: false },
  // Order matters: 701 is seen FIRST and is already answered, so it wins the
  // rank tie unless the tie-break prefers the person still owed a response.
  { company_id: TWO_REPLIERS, contact_id: 701, is_current: true },
  { company_id: TWO_REPLIERS, contact_id: 702, is_current: true },
];

/** Outbound mail, per contact. Everyone emailed also counts as "contacted". */
const OUTBOUND: Record<number, string[]> = {
  101: ["2026-05-01T10:00:00Z", "2026-05-20T10:00:00Z"], // two touches, one person
  102: ["2026-05-10T10:00:00Z"],
  103: ["2026-06-15T10:00:00Z"], // the most recent touch at CONTACTED
  201: ["2026-05-01T10:00:00Z"],
  202: ["2026-05-01T10:00:00Z"],
  701: ["2026-05-01T10:00:00Z", "2026-05-06T10:00:00Z"], // wrote back after their reply
  702: ["2026-05-01T10:00:00Z"], // never wrote back
};

/** Inbound mail from the contact's own address, per contact. */
const INBOUND: Record<number, string[]> = {
  201: ["2026-05-04T10:00:00Z"],
  701: ["2026-05-04T10:00:00Z"],
  702: ["2026-05-05T10:00:00Z"],
};

const COMPANY_IDS = [CONTACTED, REPLIED, CALLS_DONE, CALLS_UPCOMING, OVERRIDE, FORMER_ONLY, TWO_REPLIERS];

const idsIn = (q: RecordedQuery, col: string): number[] | null => {
  const f = q.filters.find(([m, c]) => m === "in" && c === col);
  return f ? (f[2] as number[]) : null;
};

/**
 * One thread per contact, which is what every fixture here means: each person's
 * mail is one conversation. The reply-thread state (CAR-253) reads thread_id, so
 * leaving it off would put a contact's whole history in one fallback bucket and
 * make the distinction untestable.
 */
function emailRows(contactIds: number[]): unknown[] {
  const rows: unknown[] = [];
  let messageId = 0;
  for (const contact_id of contactIds) {
    const thread_id = `thread-${contact_id}`;
    for (const date of OUTBOUND[contact_id] ?? []) {
      rows.push({
        contact_id,
        email_message_id: ++messageId,
        email_messages: { user_id: USER, direction: "outbound", date, from_address: "me@example.com", is_simulated: false, thread_id },
      });
    }
    for (const date of INBOUND[contact_id] ?? []) {
      rows.push({
        contact_id,
        email_message_id: ++messageId,
        email_messages: {
          user_id: USER,
          direction: "inbound",
          date,
          from_address: `person${contact_id}@example.com`,
          is_simulated: false,
          thread_id,
        },
      });
    }
  }
  return rows;
}

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
        const mine = people.filter((p) => p.company_id === company_id);
        return {
          company_id,
          current_count: mine.filter((p) => p.is_current).length,
          former_count: mine.filter((p) => !p.is_current).length,
          bench_count: 0,
          current_prospect_count: mine.filter((p) => p.is_current).length,
        };
      });

    case "companies":
      return (idsIn(q, "id") ?? []).map((id) => ({ id, name: `Company ${id}`, logo_url: null, linkedin_url: null }));

    case "contact_companies": {
      const set = new Set(idsIn(q, "company_id") ?? []);
      return people
        .filter((p) => set.has(p.company_id))
        .map((p) => ({
          company_id: p.company_id,
          contact_id: p.contact_id,
          is_current: p.is_current,
          contacts: {
            name: `Person ${p.contact_id}`,
            network_status: "prospect",
            stage_override: p.stage_override ?? null,
            persona: null,
            verified_school: null,
          },
        }));
    }

    case "email_message_contacts":
      return emailRows(idsIn(q, "contact_id") ?? []);

    case "contact_emails":
      // The address set inbound is attributed against. No bounces in this suite.
      if (q.filters.some(([m, c]) => m === "not" && c === "bounced_at")) return [];
      return (idsIn(q, "contact_id") ?? []).map((contact_id) => ({
        contact_id,
        email: `person${contact_id}@example.com`,
      }));

    case "calendar_events": {
      // Direct-FK leg. Contact 301 reaches event 700 through BOTH this and the
      // junction below — the duplicate the count has to collapse.
      const ids = new Set(idsIn(q, "contact_id") ?? []);
      const rows = [];
      if (ids.has(301)) rows.push({ id: 700, contact_id: 301, start_at: PAST, status: "confirmed" });
      // Two people with upcoming calls, and the person holding the company's
      // soonest also holds its furthest-out. That shape is what makes the test
      // below bite at BOTH levels: flipping the per-contact reducer moves 401 to
      // LATER, and flipping the company-level one picks 402's MID. Give either
      // job to a single contact and the other level goes untested.
      if (ids.has(401)) {
        rows.push({ id: 800, contact_id: 401, start_at: LATER, status: "confirmed" });
        rows.push({ id: 801, contact_id: 401, start_at: SOON, status: "confirmed" });
      }
      if (ids.has(402)) rows.push({ id: 802, contact_id: 402, start_at: MID, status: "confirmed" });
      if (ids.has(601)) rows.push({ id: 900, contact_id: 601, start_at: PAST, status: "confirmed" });
      return rows;
    }

    case "calendar_event_contacts": {
      // One past call with two attendees, plus the duplicate link for 301.
      const ids = new Set(idsIn(q, "contact_id") ?? []);
      const rows = [];
      for (const contact_id of [301, 302]) {
        if (!ids.has(contact_id)) continue;
        rows.push({
          calendar_event_id: 700,
          contact_id,
          calendar_events: { user_id: USER, start_at: PAST, status: "confirmed" },
        });
      }
      return rows;
    }

    case "meeting_contacts": {
      // A separate, older meeting for 302 only — so CALLS_DONE has two distinct
      // conversations across the company once the shared event is deduped.
      const ids = new Set(idsIn(q, "contact_id") ?? []);
      return ids.has(302)
        ? [{ meeting_id: 55, contact_id: 302, meetings: { user_id: USER, meeting_date: OLDER } }]
        : [];
    }

    case "contact_schools":
    case "interactions":
    case "referrals":
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

describe("traction chip count and recency (CAR-246)", () => {
  it("counts PEOPLE contacted, not touches, and dates the most recent one", async () => {
    const c = (await summaries()).get(CONTACTED)!;

    expect(c.traction).toBe("contacted");
    // Three people, four outbound messages between them. Counting messages here
    // would read "4 Contacted" and describe volume rather than reach.
    expect(c.traction_detail).toEqual({ count: 3, at: "2026-06-15T10:00:00Z" });
  });

  it("counts only the people who actually replied", async () => {
    const c = (await summaries()).get(REPLIED)!;

    // Both were emailed; one wrote back. The chip describes the winning stage,
    // so the second person's `contacted` does not inflate it.
    expect(c.traction).toBe("replied");
    expect(c.traction_detail).toEqual({ count: 1, at: "2026-05-04T10:00:00Z" });
  });

  it("counts one call per attendee, and never counts the same event twice", async () => {
    const c = (await summaries()).get(CALLS_DONE)!;

    // Event 700 is one call with two attendees -> 2. Contact 301 also reaches it
    // through calendar_events.contact_id, which would make it 3 without the
    // per-event dedupe. Contact 302's separate meeting adds a third.
    expect(c.traction).toBe("call_done");
    expect(c.traction_detail).toEqual({ count: 3, at: PAST });
  });

  it("counts down to the SOONEST upcoming call, not the furthest out", async () => {
    const c = (await summaries()).get(CALLS_UPCOMING)!;

    expect(c.traction).toBe("call_scheduled");
    expect(c.traction_detail).toEqual({ count: 3, at: SOON });
  });

  it("reports no count for a stage that came from an override", async () => {
    const c = (await summaries()).get(OVERRIDE)!;

    // stage_override wins over every derived signal, so the stage is real while
    // the evidence is absent. count 0 is what tells the card to fall back to the
    // bare label instead of claiming "0 Replies".
    expect(c.traction).toBe("replied");
    expect(c.traction_detail).toEqual({ count: 0, at: null });
  });

  it("ignores a former employee's calls entirely", async () => {
    const c = (await summaries()).get(FORMER_ONLY)!;

    expect(c.traction).toBeNull();
    expect(c.traction_detail).toBeNull();
  });

  it("says nothing at all when every contact has left", async () => {
    // The Qualtrics shape: every contact has left, and the only history is a
    // call with one of them. The card used to read "Call done · Follow up with
    // <name> after your call" — advice about someone who no longer works there,
    // which also outranked anything else the card could have said.
    //
    // The chip goes, the name goes, and nothing replaces them. An earlier cut
    // fell through to "Find people who work here"; that is filler on a card
    // whose own contact line already says there is nobody here, so the ladder
    // returns null and the pill is not rendered.
    const c = (await summaries()).get(FORMER_ONLY)!;

    expect(c.current_count).toBe(0);
    expect(c.lead_contact_name).toBeNull();
    expect(nextActionForCompany(c, new Date("2026-08-06T12:00:00"))).toBeNull();
  });
});

/**
 * The lead is the person the next-action line NAMES, so with two people at the
 * same stage the choice is user-visible (CAR-253). Both of these replied; one
 * has been answered and one has not. Taking the first one seen would print
 * "You had an email thread with Person 701" and leave 702's reply invisible.
 */
describe("lead selection when two current contacts have both replied (CAR-253)", () => {
  it("names the person still owed a response, not whoever came first", async () => {
    const c = (await summaries()).get(TWO_REPLIERS)!;

    expect(c.traction).toBe("replied");
    // The chip still counts BOTH: who leads the line does not change the tally.
    expect(c.traction_detail).toEqual({ count: 2, at: "2026-05-05T10:00:00Z" });

    expect(c.lead_contact_name).toBe("Person 702");
    expect(c.lead_detail?.reply).toEqual({ awaitingOurReply: true, lastMessageAt: "2026-05-05T10:00:00Z" });
    expect(nextActionForCompany(c, new Date("2026-08-06T12:00:00"))!.text).toMatch(/write back/);
  });

  it("carries the lead's OWN last outreach, not the company's most recent", async () => {
    // 701 was emailed on 05-06, later than anything sent to 702. A line that
    // names 702 must not be dated by mail sent to someone else.
    const c = (await summaries()).get(TWO_REPLIERS)!;
    expect(c.lead_detail?.last_outreach_at).toBe("2026-05-01T10:00:00Z");
  });
});

/**
 * The conversation TYPE reaches the companies list (CAR-257).
 *
 * Production symptom: Lucid Software's card read "Follow up with Spencer after
 * your call" next to "1 Call Done (1 month ago)". There was no call — contact
 * 1097 carried one meeting, titled "LinkedIn chat", `meeting_type: "text"`.
 * CAR-242 had typed every conversation, but `getContactStages` never selected
 * the column, so the type reached neither the pill nor the chip.
 *
 * These cases run the whole query path rather than the pure ladder, because the
 * defect lived in the plumbing: `company-next-action.test.ts` covers the
 * wording of each type, and this file covers the type actually arriving.
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

const USER = "user-conversation-kind";

/** The Lucid shape: one past meeting, typed `text`. */
const TEXTED = 71;
const CAREER_FAIR = 72;
const NETWORKING = 73;
const COFFEE = 74;
/** A Google-synced call: a calendar event with no meeting, so no type anywhere. */
const UNTYPED = 75;
/** A typed meeting mirroring a Google event — the CAR-250 dedupe, now carrying a kind. */
const MIRRORED = 76;
/** Two contacts, two different kinds, so the chip has to describe a mix. */
const MIXED = 77;
/** A career fair still to come. */
const SCHEDULED_FAIR = 78;

const COMPANY_IDS = [TEXTED, CAREER_FAIR, NETWORKING, COFFEE, UNTYPED, MIRRORED, SCHEDULED_FAIR, MIXED];

const GOOGLE_ID = "cmk1jdjkdsv85ctgbnl7b7fi10";
/** Far future, so it is "upcoming" whenever the suite runs. */
const FUTURE = "2099-08-14T17:00:00+00:00";

/** A past timestamp n days back, so relative-time assertions do not rot. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const LAST_MONTH = daysAgo(30);
const LAST_WEEK = daysAgo(7);

interface Person {
  company_id: number;
  contact_id: number;
  name: string;
}

const people: Person[] = [
  { company_id: TEXTED, contact_id: 801, name: "Spencer Hintze" },
  { company_id: CAREER_FAIR, contact_id: 802, name: "Dana Cho" },
  { company_id: NETWORKING, contact_id: 803, name: "Mark Lee" },
  { company_id: COFFEE, contact_id: 804, name: "Kate Ross" },
  { company_id: UNTYPED, contact_id: 805, name: "Ana Diaz" },
  { company_id: MIRRORED, contact_id: 806, name: "Jo Park" },
  { company_id: SCHEDULED_FAIR, contact_id: 807, name: "Ravi Nair" },
  // MIXED: Ivy's text chat is the RECENT one; Owen's coffee chat is older.
  { company_id: MIXED, contact_id: 808, name: "Owen Blake" },
  { company_id: MIXED, contact_id: 809, name: "Ivy Stone" },
];

/** meeting_id -> the row the meeting_contacts leg returns for it. */
const meetings: Record<number, { contact_id: number; meeting_date: string; calendar_event_id: string | null; meeting_type: string | null }> = {
  901: { contact_id: 801, meeting_date: LAST_MONTH, calendar_event_id: null, meeting_type: "text" },
  902: { contact_id: 802, meeting_date: LAST_MONTH, calendar_event_id: null, meeting_type: "career-fair" },
  903: { contact_id: 803, meeting_date: LAST_MONTH, calendar_event_id: null, meeting_type: "networking" },
  904: { contact_id: 804, meeting_date: LAST_MONTH, calendar_event_id: null, meeting_type: "coffee" },
  // The mirrored pair: the meeting is the only leg that knows this was a career
  // fair, and the calendar leg overwrites its timestamp (CAR-250).
  906: { contact_id: 806, meeting_date: LAST_MONTH, calendar_event_id: GOOGLE_ID, meeting_type: "career-fair" },
  907: { contact_id: 807, meeting_date: FUTURE, calendar_event_id: null, meeting_type: "career-fair" },
  908: { contact_id: 808, meeting_date: LAST_MONTH, calendar_event_id: null, meeting_type: "coffee" },
  909: { contact_id: 809, meeting_date: LAST_WEEK, calendar_event_id: null, meeting_type: "text" },
};

/** Calendar events, keyed by their own id. UNTYPED has one; MIRRORED shares one. */
const calendarEvents: Record<number, { contact_id: number; google_event_id: string | null; start_at: string }> = {
  505: { contact_id: 805, google_event_id: "untyped-google-id", start_at: LAST_MONTH },
  506: { contact_id: 806, google_event_id: GOOGLE_ID, start_at: LAST_WEEK },
};

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
        id: 950 + i,
        company_id,
        location_id: null,
        is_targeted: true,
        priority_score: 100 - i,
        tier: "A",
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "researching",
        locations: null,
      }));

    case "rpc:company_network_counts":
      return COMPANY_IDS.map((company_id) => ({
        company_id,
        current_count: people.filter((p) => p.company_id === company_id).length,
        former_count: 0,
        bench_count: 0,
        current_prospect_count: people.filter((p) => p.company_id === company_id).length,
      }));

    case "companies":
      return (idsIn(q, "id") ?? []).map((id) => ({ id, name: `Company ${id}`, logo_url: null, linkedin_url: null }));

    case "contact_companies": {
      const set = new Set(idsIn(q, "company_id") ?? []);
      return people
        .filter((p) => set.has(p.company_id))
        .map((p) => ({
          company_id: p.company_id,
          contact_id: p.contact_id,
          is_current: true,
          contacts: {
            name: p.name,
            network_status: "prospect",
            stage_override: null,
            persona: "product_peer",
            verified_school: null,
          },
        }));
    }

    case "meeting_contacts": {
      const set = new Set(idsIn(q, "contact_id") ?? []);
      return Object.entries(meetings)
        .filter(([, m]) => set.has(m.contact_id))
        .map(([meeting_id, m]) => ({
          meeting_id: Number(meeting_id),
          contact_id: m.contact_id,
          meetings: {
            user_id: USER,
            meeting_date: m.meeting_date,
            calendar_event_id: m.calendar_event_id,
            meeting_type: m.meeting_type,
          },
        }));
    }

    case "calendar_events": {
      const set = new Set(idsIn(q, "contact_id") ?? []);
      return Object.entries(calendarEvents)
        .filter(([, e]) => set.has(e.contact_id))
        .map(([id, e]) => ({
          id: Number(id),
          google_event_id: e.google_event_id,
          contact_id: e.contact_id,
          start_at: e.start_at,
          status: "confirmed",
        }));
    }

    case "calendar_event_contacts":
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

/** The pill the card would render for a company, via the same adapter it uses. */
async function pill(companyId: number): Promise<string | null> {
  return nextActionForCompany((await summaries()).get(companyId)!)?.text ?? null;
}

describe("the logged conversation type reaches the next-action pill (CAR-257)", () => {
  it("does not nudge a follow-up after a text chat — the Lucid regression", async () => {
    const text = await pill(TEXTED);
    expect(text).not.toMatch(/after your call/i);
    expect(text).toBe("You texted Spencer 1 month ago");
  });

  it("names the career fair, the networking event and the call", async () => {
    expect(await pill(CAREER_FAIR)).toBe("Follow up with Dana after the career fair");
    expect(await pill(NETWORKING)).toBe("Follow up with Mark after the networking event");
    expect(await pill(COFFEE)).toBe("Follow up with Kate after your call");
  });

  it("still says 'your call' for a Google-synced event, which carries no type", async () => {
    // calendar_events has no type column. Treating that absence as unknown
    // would silence every real call on the list — a far worse regression than
    // the bug being fixed.
    expect(await pill(UNTYPED)).toBe("Follow up with Ana after your call");
  });

  it("preps for a scheduled career fair rather than a call", async () => {
    expect(await pill(SCHEDULED_FAIR)).toBe("Prep for the career fair, Ravi will be there");
  });
});

describe("the kind survives the meeting/calendar dedupe (CAR-257 over CAR-250)", () => {
  it("keeps the meeting's type while the calendar event's timestamp still wins", async () => {
    // The two legs collapse onto one conversation keyed by google id. The
    // calendar leg deliberately overwrites `start_at` (CAR-206: meeting_date is
    // a naive wall clock), but it knows no type — so if the overwrite carried a
    // kind too, syncing a career fair to Google Calendar would turn it back
    // into "your call".
    const c = (await summaries()).get(MIRRORED)!;
    expect(c.traction_detail?.count).toBe(1);
    expect(c.traction_detail?.at).toBe(LAST_WEEK);
    expect(c.conversation?.kind).toBe("career-fair");
    expect(await pill(MIRRORED)).toBe("Follow up with Jo after the career fair");
  });
});

describe("a company holding more than one kind of conversation (CAR-257)", () => {
  it("speaks about the most recent one, and names the person it was with", async () => {
    // Owen's coffee chat is a month old; Ivy's text chat was last week. The pill
    // describes ONE conversation, so the person it names and the kind it
    // describes must be the same one — before the recency tie-break, the winner
    // fell to map insertion order and could have named Owen while describing
    // Ivy's exchange.
    const c = (await summaries()).get(MIXED)!;
    expect(c.lead_contact_name).toBe("Ivy Stone");
    expect(c.traction_detail?.at).toBe(LAST_WEEK);
    expect(await pill(MIXED)).toBe("You texted Ivy 1 week ago");
  });

  it("reports both conversations in the count but refuses to call them all calls", async () => {
    const c = (await summaries()).get(MIXED)!;
    expect(c.traction_detail?.count).toBe(2);
    expect(c.conversation?.allCalls).toBe(false);
  });

  it("keeps allCalls true when every conversation really was one", async () => {
    expect((await summaries()).get(COFFEE)!.conversation?.allCalls).toBe(true);
    expect((await summaries()).get(UNTYPED)!.conversation?.allCalls).toBe(true);
  });

  it("carries no conversation for a stage that does not describe one", async () => {
    // Only call_done / call_scheduled have a conversation behind them; every
    // other stage must leave the field null rather than a stale kind.
    for (const c of (await summaries()).values()) {
      if (c.traction !== "call_done" && c.traction !== "call_scheduled") {
        expect(c.conversation).toBeNull();
      }
    }
  });
});

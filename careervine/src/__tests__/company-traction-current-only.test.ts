/**
 * Company traction and the next-action lead read CURRENT employees (CAR-244).
 *
 * The production symptom this pins: BambooHR's card said "Contacted · Waiting on
 * Preston. Follow up if it's been a while" off a single 2016-era account
 * executive, while all ten current employees sat untouched. Two distinct
 * failures in one line — the wrong person is named, AND `contacted` outranks the
 * warm-intro branch of nextActionForCompany, so a contact who left a decade ago
 * SUPPRESSED the company's real next move.
 *
 * So these assert the rendered next action, not just the traction field: the
 * field being right is only half of what the user sees.
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

const USER = "user-traction";

/** The BambooHR shape: one contacted former employee, one untouched current alum in product. */
const MIXED = 44;
/** Everyone has moved on — traction blanks out entirely (CAR-246). */
const FORMER_ONLY = 55;

interface Emp {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  persona: string | null;
  /** Has an outbound email, i.e. derives to `contacted`. */
  contacted: boolean;
  /** Counts as an alum of the viewer's school. */
  alum: boolean;
}

const employment: Emp[] = [
  // Preston: left years ago, the only person ever emailed here.
  { company_id: MIXED, contact_id: 402, is_current: false, persona: "product_peer", contacted: true, alum: false },
  // The alum in product nobody has touched — the real next move.
  { company_id: MIXED, contact_id: 401, is_current: true, persona: "alum_product", contacted: false, alum: true },
  { company_id: FORMER_ONLY, contact_id: 501, is_current: false, persona: "product_peer", contacted: true, alum: false },
];

const COMPANY_IDS = [MIXED, FORMER_ONLY];

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
            persona: r.persona,
            verified_school: null,
          },
        }));
    }

    case "contact_schools":
      return (idsIn(q, "contact_id") ?? []).map((contact_id) => ({
        contact_id,
        schools: {
          name: employment.find((e) => e.contact_id === contact_id)?.alum ? "BYU" : "Other State",
        },
      }));

    case "email_message_contacts":
      // Only the `contacted` people carry an outbound message.
      return (idsIn(q, "contact_id") ?? [])
        .filter((contact_id) => employment.find((e) => e.contact_id === contact_id)?.contacted)
        .map((contact_id) => ({
          contact_id,
          email_messages: {
            user_id: USER,
            direction: "outbound",
            date: "2026-07-01",
            from_address: "me@example.com",
            is_simulated: false,
          },
        }));

    case "contact_emails":
    case "interactions":
    case "referrals":
    case "calendar_events":
    case "calendar_event_contacts":
    case "meeting_contacts":
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

const NOW = new Date("2026-08-06T12:00:00");

function action(c: CompanySummary) {
  return nextActionForCompany(c, NOW);
}

describe("company traction reads current employees (CAR-244)", () => {
  it("does not let a contacted former employee own the company's traction", async () => {
    const c = (await summaries()).get(MIXED)!;

    // The only person emailed here left the company, so the company itself has
    // no traction: nobody currently inside it has been touched.
    expect(c.traction).toBe("not_contacted");
    expect(c.lead_contact_name).toBe("Person 401");
    expect(c.lead_contact_name).not.toBe("Person 402");
  });

  it("surfaces the warm intro the former employee was suppressing", async () => {
    const c = (await summaries()).get(MIXED)!;
    const a = action(c);
    expect(a).not.toBeNull();
    const text = a!.text;

    // Before the fix this read "Waiting on Person. Follow up if it's been a
    // while" — the rank-56 contacted branch outranking the warm intro at 44.
    expect(text).toBe("Reach out to Person, your alum in product");
    expect(text).not.toMatch(/Waiting on/);
  });

  it("blanks a former-only company rather than crediting someone who left", async () => {
    const c = (await summaries()).get(FORMER_ONLY)!;

    // CAR-244 shipped a fallback here: with nobody current, traction reverted to
    // the former employees so the chip would not go empty. CAR-246 REMOVED it
    // deliberately — "Contacted (3 months ago)" beside a company where everyone
    // you know has left describes a door that is already shut. If this ever
    // reads "contacted" again, the fallback was restored; that is the
    // regression, not this expectation.
    expect(c.traction).toBeNull();
    expect(c.traction_detail).toBeNull();
    expect(c.lead_contact_name).toBeNull();
    // Nothing to say at all now: no current contacts, no deadline, no pipeline
    // state of its own.
    expect(action(c)).toBeNull();
  });

  it("still counts current employees for the who-you-know fields", async () => {
    const c = (await summaries()).get(MIXED)!;

    // Regression guard on the lines directly above the changed pass: they were
    // already current-only and must stay that way.
    expect(c.current_count).toBe(1);
    expect(c.former_count).toBe(1);
    expect(c.alum_count).toBe(1);
    expect(c.product_alum_count).toBe(1);
  });
});

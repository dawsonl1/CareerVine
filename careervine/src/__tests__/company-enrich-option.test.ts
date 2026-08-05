/**
 * getCompanies' `enrich` option: what it removes, what it must not change, and
 * what it refuses (CAR-229).
 *
 * The option exists because /outreach paid for a who-you-know pass it rendered
 * none of. The risk is not that the pass is skipped — it is that skipping it
 * changes an answer somewhere. So the assertions here are mostly EQUALITY
 * between the two modes on every field both produce, plus the two things that
 * must differ: the reads issued, and whether the five enrichment keys exist at
 * all.
 *
 * The compile-time half of the contract (an unenriched summary cannot be read
 * for a field it never computed) lives in company-enrich-option.type-test.ts,
 * because a runtime test cannot express it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "@/mcp/__tests__/helpers/recording-client";
import {
  getCompanies,
  setCompanyQueriesClient,
  type CompanyBaseSummary,
  type CompanySummary,
} from "@/lib/company-queries";

const USER = "user-enrich";

const ENRICHMENT_KEYS = [
  "alum_count",
  "product_alum_count",
  "recruiter_count",
  "lead_contact_name",
  "traction",
] as const;

/**
 * Three companies, three people. Person 1 is a BYU alum in a product role, so
 * every enrichment field lands on a NON-zero value in enriched mode — a fixture
 * where they all came back 0 could not tell "skipped" from "computed".
 */
const COMPANY_IDS = [11, 22, 33];

const employment = [
  { company_id: 11, contact_id: 101, persona: "alum_product", network_status: "prospect" },
  { company_id: 11, contact_id: 102, persona: "recruiter", network_status: "prospect" },
  { company_id: 22, contact_id: 201, persona: "product_peer", network_status: "prospect" },
];

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
      return COMPANY_IDS.map((company_id) => ({
        company_id,
        current_count: employment.filter((e) => e.company_id === company_id).length,
        former_count: 0,
        bench_count: 0,
        current_prospect_count: employment.filter((e) => e.company_id === company_id).length,
      }));

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
          is_current: true,
          contacts: {
            name: `Person ${r.contact_id}`,
            network_status: r.network_status,
            stage_override: null,
            persona: r.persona,
            verified_school: null,
          },
        }));
    }

    case "contact_schools":
      // Contact 101 is the alum; everyone else went somewhere else.
      return (idsIn(q, "contact_id") ?? []).map((contact_id) => ({
        contact_id,
        schools: { name: contact_id === 101 ? "BYU" : "Other State" },
      }));

    case "email_message_contacts":
      return (idsIn(q, "contact_id") ?? []).map((contact_id) => ({
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

const tablesRead = () => new Set((state.recorded as RecordedQuery[]).map((q) => q.table));

const byId = (rows: CompanyBaseSummary[]) => new Map(rows.map((r) => [r.id, r]));

describe("getCompanies enrich option (CAR-229)", () => {
  it("defaults to enriched, and the pass produces real values", async () => {
    const summaries = await getCompanies(USER, { scope: "targets", sort: "priority" });
    const acme = byId(summaries).get(11) as CompanySummary;

    expect(acme.alum_count).toBe(1);
    expect(acme.product_alum_count).toBe(1);
    expect(acme.recruiter_count).toBe(1);
    expect(acme.lead_contact_name).toBe("Person 101");
    expect(acme.traction).toBe("contacted");
  });

  it("enrich:true is the same call as omitting it", async () => {
    const implicit = await getCompanies(USER, { scope: "targets", sort: "priority" });
    const implicitTables = tablesRead();

    state.recorded.length = 0;
    const explicit = await getCompanies(USER, { scope: "targets", sort: "priority", enrich: true });

    expect(explicit).toEqual(implicit);
    expect(tablesRead()).toEqual(implicitTables);
  });

  it("enrich:false OMITS the five keys rather than zeroing them", async () => {
    const summaries = await getCompanies(USER, { scope: "targets", sort: "priority", enrich: false });

    for (const key of ENRICHMENT_KEYS) {
      expect(key in summaries[0], `${key} must not exist on an unenriched summary`).toBe(false);
    }
    // The lie this guards against is specifically a plausible-looking value, so
    // assert on serialization too: a caller reading JSON sees no key at all.
    expect(Object.keys(JSON.parse(JSON.stringify(summaries[0])))).not.toContain("alum_count");
  });

  it("leaves every field both modes produce byte-identical", async () => {
    const enriched = await getCompanies(USER, { scope: "targets", sort: "priority" });
    const plain = await getCompanies(USER, { scope: "targets", sort: "priority", enrich: false });

    expect(plain).toHaveLength(enriched.length);
    const enrichedById = byId(enriched);
    for (const row of plain) {
      const full = enrichedById.get(row.id)!;
      expect(row).toEqual({
        id: full.id,
        name: full.name,
        logo_url: full.logo_url,
        linkedin_url: full.linkedin_url,
        current_count: full.current_count,
        former_count: full.former_count,
        bench_count: full.bench_count,
        target: full.target,
        office_scopes: full.office_scopes,
      });
    }
    // Order is part of the answer, not just the contents.
    expect(plain.map((c) => c.id)).toEqual(enriched.map((c) => c.id));
  });

  it("skips the viewer's school, the employment read and the stage fan-out", async () => {
    await getCompanies(USER, { scope: "targets", sort: "priority", enrich: false });

    expect(tablesRead()).toEqual(new Set(["target_companies", "rpc:company_network_counts", "companies"]));
  });

  it("still applies the name search without enrichment", async () => {
    const rows = await getCompanies(USER, {
      scope: "targets",
      sort: "name",
      search: "Company 22",
      enrich: false,
    });
    // The fixture's `companies` leg ignores the ilike, so this asserts the
    // filter reached the query rather than the row set.
    const ilike = (state.recorded as RecordedQuery[]).find((q) =>
      q.filters.some(([m]) => m === "ilike"),
    );
    expect(ilike?.table).toBe("companies");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses a sort that reads what it did not compute", async () => {
    // The overloads make both of these compile errors; this covers the callers
    // types cannot see (MCP resolves its arguments from JSON).
    for (const sort of ["next", "traction"]) {
      await expect(
        getCompanies(USER, { scope: "targets", sort, enrich: false } as never),
      ).rejects.toThrow(/enrichment/);
    }
  });

  it("does not change the `all` scope, which returns the fields as 0/null", async () => {
    // Pre-existing behaviour, and MCP's list_companies(targets_only:false)
    // reads `traction` off it. The enrich option is layered on top rather than
    // folded into this, so the wire shape of that tool is untouched.
    const summaries = await getCompanies(USER, { scope: "all", search: "Company" });

    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].traction).toBeNull();
    expect(summaries[0].alum_count).toBe(0);
    expect("traction" in summaries[0]).toBe(true);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "./helpers/recording-client";
import { mockServiceClientModule } from "@/__tests__/helpers/mock-supabase";
import { runWithUserAsync } from "@/mcp/user-context";
import { registerOutreachTools } from "@/mcp/tools/outreach";

// The tools reach the database through mcp/lib/db's ensureClient(), which builds
// a real service client and parks it in the shared data-layer seams. Replacing
// the client at THAT seam (rather than calling setCompanyQueriesClient here) is
// what lets the real wiring run: ensureClient does the seam plumbing itself, so
// the test exercises the production path instead of stepping around it.
vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => createRecordingClient(state)),
);

/**
 * CAR-262. The outreach tools' handlers had no test at all — `src/mcp/tools`
 * sat at 0% and the coverage ratchet caught this PR adding branches to it.
 *
 * Mirroring the paging arithmetic in a separate file (as the first attempt did)
 * proves nothing about the tools: it tests a copy. These drive the REAL
 * handlers, which is both what the ratchet is asking for and the only way to
 * catch a tool whose window math is right and whose wiring is not.
 */

const USER = "user-outreach";

/** Register the tools against a fake server and return their handlers by name. */
function collectTools() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  registerOutreachTools({
    registerTool: (name: string, _config: unknown, fn: never) => {
      tools.set(name, fn);
    },
  } as never);
  return tools;
}

/** Call a tool and parse the JSON payload it returns. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const tools = collectTools();
  const fn = tools.get(name);
  if (!fn) throw new Error(`no tool named ${name}`);
  const res = await runWithUserAsync(USER, () => fn(args));
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** 120 targeted companies, enough that a default page cannot hold them. */
const COMPANY_IDS = Array.from({ length: 120 }, (_, i) => 1000 + i);

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
        id: 5000 + i,
        company_id,
        location_id: null,
        is_targeted: true,
        priority_score: 1000 - i,
        tier: null,
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "researching",
        locations: null,
      }));
    case "rpc:company_network_counts":
      return COMPANY_IDS.map((company_id) => ({
        company_id,
        current_count: 2,
        former_count: 1,
        bench_count: 0,
        current_prospect_count: 2,
      }));
    case "companies":
      return (idsIn(q, "id") ?? []).map((id) => ({
        id,
        name: `Company ${id}`,
        logo_url: null,
        linkedin_url: `https://linkedin.com/company/${id}`,
      }));
    case "contact_companies":
      return (idsIn(q, "company_id") ?? []).flatMap((company_id) => [
        {
          company_id,
          contact_id: company_id * 10,
          is_current: true,
          contacts: {
            name: `Person ${company_id}`,
            network_status: "prospect",
            stage_override: null,
            persona: "product_peer",
            verified_school: null,
          },
        },
      ]);
    default:
      return undefined;
  }
}

let state: RecordingState;

beforeEach(() => {
  vi.clearAllMocks();
  state = createRecordingState();
  state.route = route;
});

describe("list_companies", () => {
  it("pages with limit and offset, and says how to get the next page", async () => {
    const first = await call("list_companies", { limit: 50 });
    expect(first.companies).toHaveLength(50);
    expect(first.summary).toContain("showing 1-50");
    expect(first.summary).toContain("offset:50");

    const second = await call("list_companies", { limit: 50, offset: 50 });
    expect(second.companies).toHaveLength(50);
    expect(second.summary).toContain("showing 51-100");
    // Disjoint pages: the whole point of paging is that page 2 is new data.
    const firstIds = new Set(first.companies.map((c: { company_id: number }) => c.company_id));
    expect(second.companies.every((c: { company_id: number }) => !firstIds.has(c.company_id))).toBe(true);
  });

  it("stops advertising a next page on the last one", async () => {
    const last = await call("list_companies", { limit: 50, offset: 100 });
    expect(last.companies).toHaveLength(20);
    expect(last.summary).toContain("showing 101-120");
    expect(last.summary).not.toContain("offset:120");
  });

  it("explains an empty page instead of looking like an empty result", async () => {
    // "you paged past the end" and "you have no companies" are the same empty
    // array. Only the prose distinguishes them, so the prose is the assertion.
    const res = await call("list_companies", { limit: 10, offset: 500 });
    expect(res.companies).toEqual([]);
    expect(res.summary).toContain("none on this page");
    expect(res.summary).toContain("offset 500 of 120");
  });

  it("says nothing about paging when one page holds everything", async () => {
    const res = await call("list_companies", { limit: 200 });
    expect(res.companies).toHaveLength(120);
    expect(res.summary).not.toContain("showing");
    expect(res.summary).not.toContain("offset:");
  });

  it("includes traction for targets, and marks that it did", async () => {
    const res = await call("list_companies", {});
    expect(res.traction_included).toBe(true);
    expect(res.companies[0]).toHaveProperty("traction");
    expect(res.companies[0]).toHaveProperty("traction_detail");
    expect(res.companies[0]).toHaveProperty("alum_count");
    expect(res.companies[0]).toHaveProperty("lead_contact_name");
  });

  it("OMITS traction for the all-companies scope rather than sending null", async () => {
    // The defect this ticket exists for: `traction: null` here meant "too
    // expensive to compute", and read as "nobody has been contacted".
    const res = await call("list_companies", { targets_only: false });
    expect(res.traction_included).toBe(false);
    expect(res.companies[0]).not.toHaveProperty("traction");
    expect(res.companies[0]).not.toHaveProperty("alum_count");
    expect(res.companies[0]).not.toHaveProperty("lead_contact_name");
    // and it says so, so a model reading only the prose is not misled either
    expect(res.summary).toContain("not computed, not zero");
    // base fields are still real
    expect(res.companies[0].name).toBeTruthy();
    expect(res.companies[0].current_count).toBe(2);
  });

  it("still carries the base fields the compact row always had", async () => {
    const res = await call("list_companies", { limit: 1 });
    expect(res.companies[0]).toMatchObject({
      current_count: 2,
      former_count: 1,
      bench_count: 0,
    });
    expect(res.companies[0].linkedin_url).toContain("linkedin.com");
    expect(res.companies[0].target).toMatchObject({ status: "researching" });
  });
});

describe("list_outreach_queue", () => {
  it("pages, and numbers positions continuously across pages", async () => {
    const first = await call("list_outreach_queue", { limit: 10 });
    const second = await call("list_outreach_queue", { limit: 10, offset: 10 });

    expect(first.queue).toHaveLength(10);
    expect(first.queue[0].position).toBe(1);
    expect(second.queue[0].position).toBe(11);
    expect(second.queue.at(-1).position).toBe(20);
  });

  it("reports an empty page on the queue too", async () => {
    const res = await call("list_outreach_queue", { limit: 10, offset: 999 });
    expect(res.queue).toEqual([]);
    expect(res.summary).toContain("none on this page");
  });

  it("carries the enriched company fields on every entry", async () => {
    const res = await call("list_outreach_queue", { limit: 1 });
    expect(res.queue[0]).toHaveProperty("traction_detail");
    expect(res.queue[0]).toHaveProperty("why");
  });
});

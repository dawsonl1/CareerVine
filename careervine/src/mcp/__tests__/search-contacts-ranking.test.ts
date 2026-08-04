import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `search_contacts` used to filter with a substring check and then take the
 * FIRST `limit` rows in load order (CAR-222). Load order is `.order("name")`,
 * so on a network with thousands of contacts an exact name match sitting late
 * in the alphabet could be truncated away while an incidental tag match near
 * the top survived — and a query like "allred bryant" matched nothing at all.
 *
 * This drives the registered tool handler, so it pins rank-then-slice rather
 * than re-deriving the ranking the shared matcher already owns
 * (`src/__tests__/contact-search.test.ts`).
 */

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
}));

// The row fetch and the two enrichment lookups are stubbed; this test is about
// which rows survive `limit`, not about the queries behind them. `uid()` still
// runs for real, so the service client seam has to be mocked the way the rest of
// the MCP suite does or `ensureClient()` reaches for production env vars.
vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => ({})));
vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    fetchSearchRows: async () => state.rows,
    buildLastTouchMap: async () => new Map(),
  };
});
vi.mock("@/lib/company-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/company-queries")>()),
  getContactStages: async () => new Map(),
}));

import { mockServiceClientModule } from "../../__tests__/helpers/mock-supabase";
import { initDb } from "../lib/db";
import { registerContactTools } from "../tools/contacts";

type ToolFn = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

/** Register the contact tools against a stub server and hand back search_contacts. */
function searchTool(): ToolFn {
  let fn: ToolFn | undefined;
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolFn) => {
      if (name === "search_contacts") fn = handler;
    },
  };
  registerContactTools(server as unknown as Parameters<typeof registerContactTools>[0]);
  if (!fn) throw new Error("search_contacts was not registered");
  return fn;
}

type Row = {
  id: number;
  name: string;
  headline: string | null;
  industry: string | null;
  network_status: string;
  stage_override: string | null;
  contact_emails: Array<{ email: string; is_primary: boolean; source: string; bounced_at: string | null }>;
  contact_companies: Array<{ title: string | null; is_current: boolean; companies: { name: string } | null }>;
  contact_schools: Array<{ schools: { name: string } | null }>;
  contact_tags: Array<{ tags: { name: string } | null }>;
};

let nextId = 1;
function row(name: string, extra: Partial<Row> = {}): Row {
  return {
    id: nextId++,
    name,
    headline: null,
    industry: null,
    network_status: "active",
    stage_override: null,
    contact_emails: [],
    contact_companies: [],
    contact_schools: [],
    contact_tags: [],
    ...extra,
  };
}

async function names(args: Record<string, unknown>): Promise<string[]> {
  const result = await searchTool()(args);
  const payload = JSON.parse(result.content[0]!.text) as { results: Array<{ name: string }> };
  return payload.results.map((r) => r.name);
}

beforeEach(() => {
  nextId = 1;
  state.rows = [];
  initDb("user-1");
});

describe("search_contacts ranking", () => {
  it("keeps the exact name match when limit truncates, ranking before slicing", async () => {
    // Load order is alphabetical, so the tag match comes first. With a limit of
    // 1, the old first-N slice returned Aaron and dropped Bryant entirely.
    state.rows = [
      row("Aaron Diaz", { contact_tags: [{ tags: { name: "allred-intro" } }] }),
      row("Bryant Allred"),
    ];

    expect(await names({ query: "allred", limit: 1 })).toEqual(["Bryant Allred"]);
  });

  it("matches a multi-word query whose tokens are out of order", async () => {
    state.rows = [row("Bryant Allred")];

    expect(await names({ query: "allred bryant" })).toEqual(["Bryant Allred"]);
  });

  it("matches a query padded with whitespace", async () => {
    state.rows = [row("Bryant Allred")];

    expect(await names({ query: "  Bryant Allred  " })).toEqual(["Bryant Allred"]);
  });

  it("matches tokens spread across separate fields", async () => {
    state.rows = [
      row("Bryant Allred", {
        contact_companies: [{ title: "Senior Product Manager", is_current: true, companies: { name: "R1 RCM" } }],
      }),
      row("Bryant Searle"),
    ];

    expect(await names({ query: "bryant r1" })).toEqual(["Bryant Allred"]);
  });

  it("still excludes rows that miss a token", async () => {
    state.rows = [row("Bryant Allred")];

    expect(await names({ query: "bryant lawyer" })).toEqual([]);
  });
});

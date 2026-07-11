/**
 * CAR-76 — change events are active-network only, and bundle-imported
 * contacts never enter the per-user scrape cadence.
 *
 * Locks in the reversal of plan-29 §9 decision 2 for the Up Next surface:
 * a data-bundle subscription must never flood the home feed with tasks for
 * prospects the user hasn't added to their network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(),
}));
vi.mock("@/lib/apify/account-controls", () => ({
  getApifyControls: vi.fn(async () => ({ diffEnabled: true })),
}));

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  syncAnniversaryEvents,
  fetchChangeEventSuggestions,
} from "@/lib/change-events/change-events";
import { selectCadenceCandidates } from "@/lib/apify/cadence";

// ── Programmable chained-builder mock (same pattern as bundle-sync.test.ts) ──

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null } | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: "select", filters: [] };
    calls.push(state);
    const resolve = () => {
      const r = respond(state) ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      state.filters.push({ method, args });
      return builder;
    };
    Object.assign(builder, {
      select: chain("select"),
      insert(payload: unknown) { state.op = "insert"; state.payload = payload; return builder; },
      update(payload: unknown) { state.op = "update"; state.payload = payload; return builder; },
      upsert(payload: unknown, opts?: unknown) { state.op = "upsert"; state.payload = payload; state.filters.push({ method: "upsertOpts", args: [opts] }); return builder; },
      delete() { state.op = "delete"; return builder; },
      eq: chain("eq"), neq: chain("neq"), or: chain("or"), in: chain("in"), is: chain("is"),
      not: chain("not"), gt: chain("gt"), lt: chain("lt"), lte: chain("lte"),
      order: chain("order"), limit: chain("limit"), range: chain("range"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  const client = { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
  return { client, calls };
}

const filterArgs = (state: QueryState, method: string) =>
  state.filters.filter((f) => f.method === method).map((f) => f.args);
const hasFilter = (state: QueryState, method: string, args: unknown[]) =>
  filterArgs(state, method).some((a) => JSON.stringify(a) === JSON.stringify(args));
/** True if any filter arg on the query mentions the given substring. */
const mentionsInFilters = (state: QueryState, needle: string) =>
  state.filters.some((f) => JSON.stringify(f.args).includes(needle));

const serviceClientMock = vi.mocked(createSupabaseServiceClient);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Anniversary producer ────────────────────────────────────────────────

describe("syncAnniversaryEvents (CAR-76)", () => {
  it("scans only active-network contacts — prospects and bench never produce events", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts") return { data: [] };
      return undefined;
    });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    await syncAnniversaryEvents("user-1", new Date("2026-07-11T12:00:00Z"), { force: true });

    const contactQueries = calls.filter((c) => c.table === "contacts");
    expect(contactQueries.length).toBeGreaterThan(0);
    for (const q of contactQueries) {
      expect(hasFilter(q, "eq", ["network_status", "active"])).toBe(true);
      expect(mentionsInFilters(q, "prospect")).toBe(false);
    }
  });

  it("still upserts events for active contacts with an anniversary this month", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts") {
        // First page only; second call ends the pagination loop.
        const isFirstPage = hasFilter(state, "range", [0, 999]);
        if (!isFirstPage) return { data: [] };
        return {
          data: [{
            id: 42,
            name: "Sarah Chen",
            photo_url: null,
            industry: null,
            contact_companies: [{ company_id: 7, start_month: "Jul 2023", is_current: true, companies: { name: "Domo" } }],
          }],
        };
      }
      return undefined;
    });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    const considered = await syncAnniversaryEvents("user-2", new Date("2026-07-11T12:00:00Z"), { force: true });

    expect(considered).toBe(1);
    const upsert = calls.find((c) => c.table === "contact_change_events" && c.op === "upsert");
    expect(upsert).toBeDefined();
    expect((upsert!.payload as Array<{ contact_id: number }>)[0].contact_id).toBe(42);
  });
});

// ── Up Next reader ──────────────────────────────────────────────────────

describe("fetchChangeEventSuggestions (CAR-76)", () => {
  it("only surfaces events whose contact is in the active network", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contact_change_events") {
        return {
          data: [{
            id: 9, contact_id: 42, type: "anniversary", tier: 2,
            headline: "h", evidence: "e", suggested_title: "t", suggested_description: "d",
            contacts: { name: "Sarah Chen", photo_url: null, industry: null, network_status: "active" },
          }],
        };
      }
      return undefined;
    });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    const suggestions = await fetchChangeEventSuggestions("user-1");

    const read = calls.find((c) => c.table === "contact_change_events");
    expect(read).toBeDefined();
    expect(hasFilter(read!, "eq", ["contacts.network_status", "active"])).toBe(true);
    expect(mentionsInFilters(read!, "prospect")).toBe(false);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].contactId).toBe(42);
  });
});

// ── Scrape cadence bundle carve-out ─────────────────────────────────────

describe("selectCadenceCandidates (CAR-76)", () => {
  const BUNDLE_EXCLUSION = "import_source.is.null,import_source.not.like.bundle:*";

  it("excludes bundle-imported contacts from every selection pass", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "scrape_runs" || state.table === "suppressed_imports") return { data: [] };
      if (state.table === "contacts") {
        const isBenchPass = hasFilter(state, "in", ["network_status", ["bench"]]);
        return {
          data: [{
            id: isBenchPass ? 2 : 1,
            linkedin_url: `https://www.linkedin.com/in/person-${isBenchPass ? "b" : "a"}`,
            last_scraped_at: null,
            scrape_failed_at: null,
          }],
        };
      }
      return undefined;
    });

    const picked = await selectCadenceCandidates(client as unknown as ReturnType<typeof createSupabaseServiceClient>, "user-1", 2);

    const contactQueries = calls.filter((c) => c.table === "contacts");
    expect(contactQueries).toHaveLength(2); // active/prospect pass, then bench pass
    for (const q of contactQueries) {
      expect(hasFilter(q, "or", [BUNDLE_EXCLUSION])).toBe(true);
    }
    expect(picked).toHaveLength(2);
  });
});

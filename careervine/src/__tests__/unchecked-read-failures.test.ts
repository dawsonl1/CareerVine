/**
 * CAR-158 F3 — the nine reads that used to drop their `error` inside array
 * destructuring now fail loudly instead of resolving empty.
 *
 * Each case pins the behaviour that empty-on-error was hiding: a dropped read
 * is no longer indistinguishable from "there is nothing here". The absence
 * cases are pinned alongside, because must() must not turn a legitimately
 * missing row into a failure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(),
}));
vi.mock("@/lib/apify/client", () => ({
  getRun: vi.fn(),
  getDatasetItems: vi.fn(),
  getAppBaseUrl: vi.fn(() => "https://www.careervine.app"),
  isApifyConfigured: vi.fn(() => true),
  startProfileSearchRun: vi.fn(),
}));

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getRun, getDatasetItems } from "@/lib/apify/client";
import { ingestDiscoveryRun } from "@/lib/apify/discovery";
import { fetchSuggestionCandidates } from "@/lib/ai-followup/generate-suggestions";
import { gatherContactContext } from "@/lib/ai-followup/gather-context";
import { getContactContext } from "@/lib/ai-helpers";

// ── Programmable chained-builder mock (same pattern as bundle-sync.test.ts) ──

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Result = { data?: unknown; error?: { message: string } | null };
type Responder = (state: QueryState) => Result | undefined;

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

const READ_FAILED = { message: "connection reset by peer" };

const serviceClientMock = vi.mocked(createSupabaseServiceClient);

/** Point createSupabaseServiceClient at a mock and hand back its call log. */
function useClient(respond: Responder) {
  const { client, calls } = createMockClient(respond);
  serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── discovery: suppression + dedupe reads gate PAID re-scraping ─────────

describe("loadPartitionContext reads fail the run instead of widening it", () => {
  const run = { id: 7, user_id: "user-1", company_id: 42 };

  function stubApify() {
    vi.mocked(getRun).mockResolvedValue({
      status: "SUCCEEDED",
      usageTotalUsd: 0.05,
      defaultDatasetId: "ds-1",
    } as unknown as Awaited<ReturnType<typeof getRun>>);
    vi.mocked(getDatasetItems).mockResolvedValue([
      {
        id: "ACwAAAtest0001",
        linkedinUrl: "https://www.linkedin.com/in/ACwAAAtest0001",
        firstName: "Jordan",
        lastName: "Rivera",
        summary: "Senior PM",
        currentPositions: [{ title: "Senior Product Manager", companyName: "Adobe", companyId: "1480", current: true }],
      },
    ] as unknown as Awaited<ReturnType<typeof getDatasetItems>>);
  }

  it("marks the run failed and ingests nothing when the suppression read errors", async () => {
    stubApify();
    const { client, calls } = createMockClient((s) =>
      s.table === "suppressed_imports" ? { error: READ_FAILED } : { data: [] },
    );

    await ingestDiscoveryRun(
      client as unknown as Parameters<typeof ingestDiscoveryRun>[0],
      run,
      "apify-run-1",
      "2026-07-19T00:00:00Z",
    );

    // A suppressed profile must never be re-surfaced (and re-scraped) because
    // its tombstone list failed to load.
    expect(calls.some((c) => c.table === "discovery_candidates")).toBe(false);
    const terminal = calls.find((c) => c.table === "scrape_runs" && c.op === "update");
    expect(terminal?.payload).toMatchObject({ status: "failed" });
  });

  it("marks the run failed and ingests nothing when the contact dedupe read errors", async () => {
    stubApify();
    const { client, calls } = createMockClient((s) =>
      s.table === "contacts" ? { error: READ_FAILED } : { data: [] },
    );

    await ingestDiscoveryRun(
      client as unknown as Parameters<typeof ingestDiscoveryRun>[0],
      run,
      "apify-run-1",
      "2026-07-19T00:00:00Z",
    );

    expect(calls.some((c) => c.table === "discovery_candidates")).toBe(false);
    const terminal = calls.find((c) => c.table === "scrape_runs" && c.op === "update");
    expect(terminal?.payload).toMatchObject({ status: "failed" });
  });

  it("still ingests normally when every context read simply comes back empty", async () => {
    stubApify();
    const { client, calls } = createMockClient(() => ({ data: [] }));

    await ingestDiscoveryRun(
      client as unknown as Parameters<typeof ingestDiscoveryRun>[0],
      run,
      "apify-run-1",
      "2026-07-19T00:00:00Z",
    );

    expect(calls.some((c) => c.table === "discovery_candidates")).toBe(true);
    const terminal = calls.find((c) => c.table === "scrape_runs" && c.op === "update");
    expect(terminal?.payload).toMatchObject({ status: "succeeded" });
  });
});

// ── suggestions: the CAR-119 "everyone looks never-contacted" regression ──

describe("fetchSuggestionCandidates last-touch reads (CAR-119)", () => {
  const contactRow = {
    id: 1,
    name: "Jordan Rivera",
    photo_url: null,
    industry: null,
    contact_status: "student",
    expected_graduation: null,
    follow_up_frequency_days: null,
    notes: null,
    met_through: null,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("throws when the interactions read fails, rather than reporting zero touches", async () => {
    useClient((s) => {
      if (s.table === "contacts") return { data: [contactRow] };
      if (s.table === "interactions") return { error: READ_FAILED };
      return { data: [] };
    });

    await expect(fetchSuggestionCandidates("user-1")).rejects.toMatchObject(READ_FAILED);
  });

  it("throws when the meeting-link read fails", async () => {
    useClient((s) => {
      if (s.table === "contacts") return { data: [contactRow] };
      if (s.table === "meeting_contacts") return { error: READ_FAILED };
      return { data: [] };
    });

    await expect(fetchSuggestionCandidates("user-1")).rejects.toMatchObject(READ_FAILED);
  });

  it("reports a genuinely untouched contact as never contacted", async () => {
    useClient((s) => (s.table === "contacts" ? { data: [contactRow] } : { data: [] }));

    const [candidate] = await fetchSuggestionCandidates("user-1");
    expect(candidate).toMatchObject({ id: 1, last_touch: null, interaction_count: 0 });
  });
});

// ── gather-context: AI prompt enrichment ───────────────────────────────

describe("gatherContactContext interaction history", () => {
  const contact = {
    name: "Jordan Rivera",
    industry: null,
    notes: null,
    met_through: null,
    contact_status: null,
    expected_graduation: null,
    locations: null,
    contact_emails: [],
    contact_companies: [],
    contact_schools: [],
  };

  it("throws when the interactions read fails", async () => {
    useClient((s) => {
      if (s.table === "contacts") return { data: contact };
      if (s.table === "interactions") return { error: READ_FAILED };
      return { data: [] };
    });

    await expect(gatherContactContext("user-1", 1)).rejects.toMatchObject(READ_FAILED);
  });

  it("reports no interactions when the contact genuinely has none", async () => {
    useClient((s) => (s.table === "contacts" ? { data: contact } : { data: [] }));

    const ctx = await gatherContactContext("user-1", 1);
    expect(ctx.interactions).toEqual([]);
    expect(ctx.hasRichData).toBe(false);
  });
});

// ── ai-helpers: sender profile + contact context ───────────────────────

describe("getContactContext profile and contact reads", () => {
  const userRow = { first_name: "Dawson", last_name: "Pitcher", email: "d@example.com" };

  it("throws when the sender profile read fails", async () => {
    useClient((s) => (s.table === "users" ? { error: READ_FAILED } : { data: null }));

    await expect(getContactContext("user-1", 1)).rejects.toMatchObject(READ_FAILED);
  });

  it("throws when the contact read fails", async () => {
    useClient((s) => {
      if (s.table === "users") return { data: userRow };
      if (s.table === "contacts") return { error: READ_FAILED };
      return { data: null };
    });

    await expect(getContactContext("user-1", 1)).rejects.toMatchObject(READ_FAILED);
  });

  it("leaves contactName empty for a missing contact, so draft-intro can still 404", async () => {
    useClient((s) => (s.table === "users" ? { data: userRow } : { data: null }));

    const ctx = await getContactContext("user-1", 999);
    expect(ctx.contactName).toBe("");
    expect(ctx.senderName).toBe("Dawson Pitcher");
  });

  it("skips the contact query entirely on the sender-info-only path", async () => {
    const calls = useClient((s) => (s.table === "users" ? { data: userRow } : { data: null }));

    const ctx = await getContactContext("user-1", 0);
    expect(calls.some((c) => c.table === "contacts")).toBe(false);
    expect(ctx.senderEmail).toBe("d@example.com");
  });
});

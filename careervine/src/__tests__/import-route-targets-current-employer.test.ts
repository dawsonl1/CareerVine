/**
 * Extension save targets the CURRENT employer only (CAR-263).
 *
 * The rule that matters here does not live in `ensureCompanyTargets` — it lives
 * in the caller. A profile save mints a company row for every job in the
 * person's history (the payload schema puts no cap on `experience`), so a
 * 15-job profile would target fifteen companies if the `is_current` gate slipped.
 * `ensure-company-targets.test.ts` owns the helper's own rules.
 *
 * Extension auth and company resolution are mocked so the real POST handler runs
 * against a programmable client, and the assertion is on what actually reaches
 * `target_companies`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}
let calls: QueryState[] = [];
let respond: (s: QueryState) => { data?: unknown; error?: unknown } | undefined = () => ({ data: null });

function makeBuilder(table: string) {
  const state: QueryState = { table, op: "select", filters: [] };
  calls.push(state);
  const resolve = () => {
    const r = respond(state) ?? {};
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const builder: Record<string, unknown> = {};
  const chain = (m: string) => (...args: unknown[]) => { state.filters.push({ method: m, args }); return builder; };
  Object.assign(builder, {
    select: chain("select"),
    insert(p: unknown) { state.op = "insert"; state.payload = p; return builder; },
    update(p: unknown) { state.op = "update"; state.payload = p; return builder; },
    delete() { state.op = "delete"; return builder; },
    eq: chain("eq"), is: chain("is"), in: chain("in"), or: chain("or"),
    order: chain("order"), limit: chain("limit"),
    async single() { return resolve(); },
    async maybeSingle() { return resolve(); },
    then(f: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(f); },
  });
  return builder;
}

vi.mock("@/lib/extension-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-auth")>();
  return {
    ...actual,
    getExtensionAuth: vi.fn(async () => ({
      user: { id: "user-1" },
      supabase: { from: (t: string) => makeBuilder(t) },
    })),
  };
});

// One company row per distinct name, ids assigned in first-seen order.
const companyIds = new Map<string, number>();
vi.mock("@/lib/company-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/company-helpers")>();
  return {
    ...actual,
    findOrCreateCompany: vi.fn(async (_c: unknown, input: { name: string }) => {
      if (!companyIds.has(input.name)) companyIds.set(input.name, companyIds.size + 1);
      return { id: companyIds.get(input.name)!, name: input.name, possible_duplicate_of: null };
    }),
    findOrCreateLocation: vi.fn(async () => ({ id: 1 })),
    ensureCompanyLocation: vi.fn(async () => {}),
  };
});

// Side effects the save fires that have nothing to do with targeting.
vi.mock("@/lib/apify/scrape-service", () => ({ triggerEnrichOnSave: vi.fn(async () => ({ status: "skipped" })) }));
vi.mock("@/lib/gmail", () => ({ backfillEmailsForContact: vi.fn(async () => {}) }));
vi.mock("@/lib/contact-email-history", () => ({ syncContactEmailHistoryIfPaid: vi.fn(async () => {}) }));
vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule());
vi.mock("@/lib/onboarding/extension-server", () => ({ advanceExtensionOnboarding: vi.fn(async () => {}) }));
vi.mock("@/lib/data/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/contacts")>();
  return { ...actual, createContact: vi.fn(async () => ({ id: 100 })), updateContact: vi.fn(async () => ({ id: 100 })) };
});

import { NextRequest } from "next/server";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { POST } from "@/app/api/contacts/import/route";

function makeReq(experience: Array<Record<string, unknown>>) {
  return new NextRequest("https://www.careervine.app/api/contacts/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileData: { name: "Jane Doe", linkedin_url: "https://linkedin.com/in/jane", experience },
    }),
  });
}

/** company_ids that reached target_companies. */
function targetedCompanyIds(): number[] {
  return calls
    .filter((c) => c.table === "target_companies" && c.op === "insert")
    .flatMap((c) => (c.payload as Array<{ company_id: number }>) ?? [])
    .map((r) => r.company_id);
}

describe("POST /api/contacts/import — targets the current employer (CAR-263)", () => {
  beforeEach(() => {
    calls = [];
    companyIds.clear();
    respond = () => ({ data: null });
  });

  it("targets the company the person works at now", async () => {
    const res = await POST(makeReq([{ company: "Stripe", title: "PM", is_current: true }]));
    expect(res.status).toBe(200);
    expect(targetedCompanyIds()).toEqual([companyIds.get("Stripe")]);
  });

  it("does NOT target past employers from the same save", async () => {
    // The regression this exists for: a long career history turning into a dozen
    // targets because the is_current gate was dropped.
    await POST(
      makeReq([
        { company: "Stripe", title: "PM", is_current: true },
        { company: "Adobe", title: "APM", is_current: false },
        { company: "Nike", title: "Intern", is_current: false },
      ]),
    );
    expect(targetedCompanyIds()).toEqual([companyIds.get("Stripe")]);
  });

  it("targets nothing when every role has ended", async () => {
    await POST(makeReq([{ company: "Adobe", title: "APM", is_current: false }]));
    expect(targetedCompanyIds()).toEqual([]);
  });

  it("does not re-target a company that already has a row", async () => {
    // Standing in for a company the user untargeted: the row exists, so nothing
    // is written and `is_targeted` is never touched.
    respond = (s) =>
      s.table === "target_companies" && s.op === "select" ? { data: [{ company_id: 1 }] } : { data: null };
    await POST(makeReq([{ company: "Stripe", title: "PM", is_current: true }]));
    expect(targetedCompanyIds()).toEqual([]);
  });
});

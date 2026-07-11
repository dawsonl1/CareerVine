import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkFastApplyEligibility,
  runFastApplyStep,
  FAST_APPLY_BATCH,
} from "@/lib/bundle-fast-apply";
import { computeContactFingerprint, normalizeTagNames } from "@/lib/bundle-fingerprint";
import { hashPayload } from "@/lib/bundle-publish";
import type { BundleCore, SubscriptionCore } from "@/lib/bundle-sync";
import { readSyncCheckpoint } from "@/lib/bundle-sync";
import { trackServer, checkContactMilestone } from "@/lib/analytics/server";

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn(async () => {}),
  checkContactMilestone: vi.fn(async () => {}),
}));

// ── Programmable chained-builder mock (same shape as bundle-sync.test.ts) ──

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (
  state: QueryState,
) => { data?: unknown; error?: { message: string } | null; count?: number | null } | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: "select", filters: [] };
    calls.push(state);
    const resolve = () => {
      const r = respond(state) ?? {};
      return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
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
      gt: chain("gt"), lt: chain("lt"), lte: chain("lte"), ilike: chain("ilike"),
      order: chain("order"), limit: chain("limit"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  const client = { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
  return { client, calls };
}

const byTable = (calls: QueryState[], table: string, op?: QueryState["op"]) =>
  calls.filter((c) => c.table === table && (!op || c.op === op));

// ── Fixtures ───────────────────────────────────────────────────────────

const BUNDLE: BundleCore = { id: 1, slug: "apm-data-bundle", name: "APM Data Bundle", version: 3, resolved_version: 3 };
const SUB: SubscriptionCore = { id: 7, user_id: "user-1", bundle_id: 1, status: "active", synced_version: 0 };

const JANE_PAYLOAD = {
  name: "Jane Analyst",
  linkedin_url: "https://www.linkedin.com/in/jane-analyst",
  headline: "APM at Acme",
  network_status: "prospect",
  persona: "alum_product",
  emails: [{ email: "jane@acme.com", source: "scraped" }],
  experiences: [
    {
      title: "APM",
      company: { name: "Acme", linkedin_company_id: "555" },
      is_current: true,
      location_raw: "Provo, Utah, United States",
    },
  ],
  education: [
    { school_name: "BYU", degree: "BS", field_of_study: "IS", start_year: 2022 },
    // Same school + start_year, different degree: DB unique index allows one.
    { school_name: "BYU", degree: "Minor", field_of_study: "CS", start_year: 2022 },
  ],
  tags: ["APM-2026", "Warm"],
};

function janeRow(overrides: Record<string, unknown> = {}) {
  const payload_hash = hashPayload(JANE_PAYLOAD as never);
  return {
    id: 301,
    linkedin_url: "https://www.linkedin.com/in/jane-analyst",
    payload: JANE_PAYLOAD,
    payload_schema_version: 1,
    payload_hash,
    resolved: {
      payload_hash,
      profile_location_id: 55,
      experiences: [{ company_id: 10, location_id: 20, location_source: "experience" }],
      education: [{ school_id: 30 }, { school_id: 30 }],
    },
    ...overrides,
  };
}

/** Responder for a blank subscriber: prospect rows in, inserts succeed. */
function fastResponder(prospects: unknown[]): Responder {
  let nextContactId = 500;
  return (state) => {
    if (state.table === "bundle_prospects" && state.op === "select") return { data: prospects };
    if (state.table === "contacts" && state.op === "insert") {
      const rows = state.payload as Array<{ linkedin_url: string }>;
      return { data: rows.map((r) => ({ id: nextContactId++, linkedin_url: r.linkedin_url })) };
    }
    if (state.op === "select") return { data: [], count: 0 };
    return { data: [] };
  };
}

beforeEach(() => {
  vi.mocked(trackServer).mockClear();
  vi.mocked(checkContactMilestone).mockClear();
});

// ── Eligibility gates ──────────────────────────────────────────────────

describe("checkFastApplyEligibility", () => {
  it("rejects a non-first sync without touching the DB", async () => {
    const { client, calls } = createMockClient(() => ({ count: 0 }));
    const ok = await checkFastApplyEligibility(client, { ...SUB, synced_version: 2 }, BUNDLE, 3);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unresolved bundle without touching the DB", async () => {
    const { client, calls } = createMockClient(() => ({ count: 0 }));
    expect(await checkFastApplyEligibility(client, SUB, { ...BUNDLE, resolved_version: 2 }, 3)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a pin behind the resolved version (mid-publish race)", async () => {
    const { client } = createMockClient(() => ({ count: 0 }));
    expect(await checkFastApplyEligibility(client, SUB, { ...BUNDLE, version: 4, resolved_version: 4 }, 3)).toBe(false);
  });

  it("rejects a subscriber with any existing contacts", async () => {
    const { client } = createMockClient((state) =>
      state.table === "contacts" ? { count: 3 } : { count: 0 },
    );
    expect(await checkFastApplyEligibility(client, SUB, BUNDLE, 3)).toBe(false);
  });

  it("rejects a subscriber with suppression tombstones", async () => {
    const { client } = createMockClient((state) =>
      state.table === "suppressed_imports" ? { count: 1 } : { count: 0 },
    );
    expect(await checkFastApplyEligibility(client, SUB, BUNDLE, 3)).toBe(false);
  });

  it("rejects a subscriber that owns any pre-existing tags", async () => {
    // A pre-existing mixed-case tag colliding with a bundle tag would poison
    // the fast path's precomputed fingerprint (CAR-62 review) — take the merge
    // path, which re-reads the stored casing.
    const { client } = createMockClient((state) => (state.table === "tags" ? { count: 1 } : { count: 0 }));
    expect(await checkFastApplyEligibility(client, SUB, BUNDLE, 3)).toBe(false);
  });

  it("accepts a blank subscriber of a fully resolved bundle", async () => {
    const { client } = createMockClient(() => ({ count: 0 }));
    expect(await checkFastApplyEligibility(client, SUB, BUNDLE, 3)).toBe(true);
  });
});

// ── Fast apply step ────────────────────────────────────────────────────

describe("runFastApplyStep", () => {
  it("applies a short batch end to end and commits the sync", async () => {
    const { client, calls } = createMockClient(fastResponder([janeRow()]));
    const result = await runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 });

    expect(result.done).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);

    // Contact row carries bundle provenance and the resolved profile location.
    const contactInsert = byTable(calls, "contacts", "insert")[0];
    const contactRow = (contactInsert.payload as Array<Record<string, unknown>>)[0];
    expect(contactRow.user_id).toBe("user-1");
    expect(contactRow.import_source).toBe("bundle:apm-data-bundle");
    expect(contactRow.location_id).toBe(55);
    expect(String(contactRow.notes)).toContain('Imported from data bundle "APM Data Bundle"');

    // Employment straight from the snapshot ids.
    const empRows = byTable(calls, "contact_companies", "insert")[0].payload as Array<Record<string, unknown>>;
    expect(empRows).toHaveLength(1);
    expect(empRows[0]).toMatchObject({
      contact_id: 500,
      company_id: 10,
      location_id: 20,
      location_source: "experience",
      source: "scraped",
    });

    // Education deduped on the DB unique key (double major → one row).
    const eduUpsert = byTable(calls, "contact_schools", "upsert")[0];
    expect(eduUpsert.payload as unknown[]).toHaveLength(1);
    expect(eduUpsert.filters.find((f) => f.method === "upsertOpts")?.args[0]).toEqual({
      onConflict: "contact_id,school_id,start_year",
      ignoreDuplicates: true,
    });

    // Linkage marks the contact bundle-created at the pinned version.
    const linkRows = byTable(calls, "bundle_subscription_contacts", "insert")[0].payload as Array<
      Record<string, unknown>
    >;
    expect(linkRows[0]).toMatchObject({
      subscription_id: 7,
      contact_id: 500,
      bundle_prospect_id: 301,
      created_by_bundle: true,
      first_applied_version: 3,
      last_applied_version: 3,
    });

    // Sync committed directly (blank subscriber has no removal phase).
    const commit = byTable(calls, "bundle_subscriptions", "update").find(
      (c) => (c.payload as Record<string, unknown>).synced_version === 3,
    );
    expect(commit).toBeTruthy();
    expect((commit!.payload as Record<string, unknown>).sync_cursor).toBeNull();

    expect(vi.mocked(trackServer)).toHaveBeenCalledWith("user-1", "contact_imported", {
      source: "bundle",
      count: 1,
    });
    expect(vi.mocked(checkContactMilestone)).toHaveBeenCalledWith("user-1");
  });

  it("seeds bundle_contact_state with a fingerprint a re-read reproduces (parity invariant)", async () => {
    const { client, calls } = createMockClient(fastResponder([janeRow()]));
    await runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 });

    const contactRow = (byTable(calls, "contacts", "insert")[0].payload as Array<Record<string, unknown>>)[0];
    const stateRow = (byTable(calls, "bundle_contact_state", "insert")[0].payload as Array<
      Record<string, unknown>
    >)[0];

    // Simulate what fetchTouchSignals reads later: the inserted contact
    // columns + tag names as addTagsToContacts stores them (lowercased).
    const reRead = computeContactFingerprint({
      name: contactRow.name as string,
      headline: contactRow.headline as string | null,
      notes: contactRow.notes as string | null,
      persona: contactRow.persona as string | null,
      network_status: contactRow.network_status as string | null,
      stage_override: null,
      manual_employment_keys: [],
      manual_emails: [],
      tags: normalizeTagNames(["APM-2026", "Warm"]),
    });
    expect(stateRow.applied_fingerprint).toBe(reRead);
    expect(stateRow.user_touched).toBe(false);
    expect(stateRow.apply_started_at).toBeNull();
  });

  it("keeps two same-school degrees when start_year is NULL (index is NULLS-distinct)", async () => {
    const payload = {
      name: "Dee Major",
      linkedin_url: "https://www.linkedin.com/in/dee-major",
      network_status: "prospect",
      emails: [],
      experiences: [],
      education: [
        { school_name: "BYU", degree: "BS", field_of_study: "IS" },
        { school_name: "BYU", degree: "MISM", field_of_study: "IS" },
      ],
      tags: [],
    };
    const payload_hash = hashPayload(payload as never);
    const row = {
      id: 401,
      linkedin_url: payload.linkedin_url,
      payload,
      payload_schema_version: 1,
      payload_hash,
      resolved: {
        payload_hash,
        profile_location_id: null,
        experiences: [],
        education: [{ school_id: 30 }, { school_id: 30 }],
      },
    };
    const { client, calls } = createMockClient(fastResponder([row]));
    await runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 });

    const eduRows = byTable(calls, "contact_schools", "upsert")[0].payload as Array<Record<string, unknown>>;
    expect(eduRows).toHaveLength(2); // both degrees kept — NULL years don't collide
    expect(eduRows.map((r) => r.degree).sort()).toEqual(["BS", "MISM"]);
  });

  it("reports rows without a hash-current resolution as skipped instead of applying them", async () => {
    const stale = janeRow({ id: 302, resolved: { ...janeRow().resolved as object, payload_hash: "stale" } });
    const { client, calls } = createMockClient(fastResponder([janeRow(), stale]));
    const result = await runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 });

    expect(result.applied).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("missing_resolution");
    expect((byTable(calls, "contacts", "insert")[0].payload as unknown[]).length).toBe(1);
  });

  it("hands back a fast cursor and persists the checkpoint on a full batch", async () => {
    const rows = Array.from({ length: FAST_APPLY_BATCH }, (_, i) => {
      const url = `https://www.linkedin.com/in/p-${i}`;
      const payload = { name: `P ${i}`, linkedin_url: url };
      const payload_hash = hashPayload(payload as never);
      return {
        id: i + 1,
        linkedin_url: url,
        payload,
        payload_schema_version: 1,
        payload_hash,
        resolved: { payload_hash, profile_location_id: null, experiences: [], education: [] },
      };
    });
    const { client, calls } = createMockClient(fastResponder(rows));
    const result = await runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 });

    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ phase: "fast", afterId: FAST_APPLY_BATCH });
    expect(result.applied).toBe(FAST_APPLY_BATCH);

    // Checkpoint persisted with the pin; the checkpoint reader accepts it.
    const checkpointWrite = byTable(calls, "bundle_subscriptions", "update").find((c) =>
      Boolean((c.payload as Record<string, unknown>).sync_cursor),
    );
    expect(checkpointWrite).toBeTruthy();
    const stored = (checkpointWrite!.payload as Record<string, unknown>).sync_cursor;
    expect(readSyncCheckpoint(stored, 0)).toEqual({ phase: "fast", afterId: FAST_APPLY_BATCH, pinnedVersion: 3 });

    // No commit on a partial step.
    const commit = byTable(calls, "bundle_subscriptions", "update").find(
      (c) => (c.payload as Record<string, unknown>).synced_version != null,
    );
    expect(commit).toBeUndefined();
  });

  it("throws (instead of silently degrading) when the contact bulk insert fails", async () => {
    const { client } = createMockClient((state) => {
      if (state.table === "bundle_prospects") return { data: [janeRow()] };
      if (state.table === "contacts" && state.op === "insert") return { error: { message: "boom" } };
      return { data: [] };
    });
    await expect(runFastApplyStep(client, SUB, BUNDLE, { afterId: 0, pinnedVersion: 3 })).rejects.toThrow(
      "contact insert failed",
    );
  });
});

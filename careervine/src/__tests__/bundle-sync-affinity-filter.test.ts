/**
 * The bundle filter: which prospects a subscriber actually receives (CAR-213).
 *
 * Counts are asserted EXACTLY, never `> 0` (plan §8.4) — `> 0` passes when 1
 * of 7 lands, which is the shape a broken filter actually produces.
 *
 * The cursor cases are the ones worth writing carefully. Both apply paths
 * advance from the last row READ, so filtering the array in place would stall
 * the cursor whenever a chunk is entirely alumni-only: the same rows would be
 * re-read forever and the removal phase would never run. That bug is invisible
 * to a count assertion, so it gets its own tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyBundleDelta, type BundleCore, type SubscriptionCore } from "@/lib/bundle-sync";
import { importPeopleChunk } from "@/lib/bulk-import";
import { checkFastApplyEligibility } from "@/lib/bundle-fast-apply";

vi.mock("@/lib/bulk-import", () => ({
  importPeopleChunk: vi.fn(async () => ({ results: [], offices_established: 0 })),
}));
vi.mock("@/lib/bundle-fast-apply", () => ({
  checkFastApplyEligibility: vi.fn(async () => false),
  runFastApplyStep: vi.fn(async () => ({
    done: true, nextCursor: null, pinnedVersion: 4, applied: 0,
    removedContacts: 0, orphanedLinks: 0, skipped: [], path: "fast",
  })),
}));

const importMock = vi.mocked(importPeopleChunk);
const eligibilityMock = vi.mocked(checkFastApplyEligibility);

const BUNDLE: BundleCore = { id: 9, slug: "apm", name: "APM", version: 4, resolved_version: 0 };
const SUB: SubscriptionCore = { id: 77, user_id: "user-1", bundle_id: 9, status: "active", synced_version: 2 };

let prospectSelects = 0;
let lastGtId: unknown;

function prospect(id: number, isAlumni: boolean, persona: string | null) {
  return {
    id,
    linkedin_url: `https://www.linkedin.com/in/p${id}`,
    payload: { name: `P${id}`, linkedin_url: `https://www.linkedin.com/in/p${id}`, tags: [] },
    payload_schema_version: 1,
    payload_hash: `h${id}`,
    resolved: null,
    is_alumni: isAlumni,
    persona,
  };
}

/** One full sample of the live bundle's composition, in miniature. */
const MIXED = [
  prospect(1, true, "alum_product"),    // kept: a PM at a target company
  prospect(2, true, "alum_other"),      // DROPPED: the alumni-only population
  prospect(3, false, "product_leader"), // kept
  prospect(4, true, "recruiter"),       // kept: recruiters hire regardless
  prospect(5, true, "alum_other"),      // DROPPED
  prospect(6, true, null),              // kept: fail-safe on unknown persona
  prospect(7, false, "product_peer"),   // kept
];

function createClient(rows: unknown[], university: string | null) {
  function makeBuilder(table: string) {
    const filters: Array<{ m: string; a: unknown[] }> = [];
    let op = "select";
    const state = { table, get op() { return op; }, filters };
    const resolve = () => {
      if (table === "users") return { data: { university }, error: null, count: null };
      if (table === "bundle_prospects" && op === "select") {
        const isRemoval = filters.some((f) => f.m === "gt" && f.a[0] === "removed_in_version");
        if (isRemoval) return { data: [], error: null, count: null };
        prospectSelects++;
        lastGtId = filters.find((f) => f.m === "gt" && f.a[0] === "id")?.a[1];
        return { data: rows, error: null, count: null };
      }
      if (op !== "select") return { data: { id: 1 }, error: null, count: 1 };
      return { data: [], error: null, count: null };
    };
    const builder: Record<string, unknown> = {};
    const chain = (m: string) => (...a: unknown[]) => { filters.push({ m, a }); return builder; };
    Object.assign(builder, {
      select: chain("select"),
      insert() { op = "insert"; return builder; },
      update() { op = "update"; return builder; },
      upsert() { op = "upsert"; return builder; },
      delete() { op = "delete"; return builder; },
      eq: chain("eq"), neq: chain("neq"), or: chain("or"), in: chain("in"), is: chain("is"),
      gt: chain("gt"), lt: chain("lt"), lte: chain("lte"), order: chain("order"), limit: chain("limit"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onF: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onF); },
    });
    void state;
    return builder;
  }
  return { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient;
}

/** LinkedIn URLs handed to the import engine — i.e. what the user receives. */
function importedIds(): number[] {
  // importPeopleChunk(client, userId, inputs, opts) — inputs is arg 2, and
  // each entry is { mapped }.
  return importMock.mock.calls
    .flatMap((c) => (c[2] ?? []) as Array<{ mapped: { linkedin_url: string } }>)
    .map((p) => Number(p.mapped.linkedin_url.split("/in/p")[1]))
    .sort((a, b) => a - b);
}

beforeEach(() => {
  importMock.mockClear();
  importMock.mockResolvedValue({ results: [], offices_established: 0 });
  eligibilityMock.mockClear();
  eligibilityMock.mockResolvedValue(false);
  prospectSelects = 0;
  lastGtId = undefined;
});

describe("who receives which prospects", () => {
  it("a BYU-family subscriber receives EVERY prospect", async () => {
    // The positive control for the whole file. Without it, a filter that
    // dropped everything would satisfy every exclusion assertion below.
    await applyBundleDelta(createClient(MIXED, "Brigham Young University"), SUB, BUNDLE, {});
    expect(importedIds()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a subscriber with a non-BYU school receives everyone EXCEPT the alumni-only", async () => {
    await applyBundleDelta(createClient(MIXED, "Utah State University"), SUB, BUNDLE, {});
    expect(importedIds()).toEqual([1, 3, 4, 6, 7]);
  });

  it("a subscriber with NO school on file is treated the same as a non-BYU one", async () => {
    // Blank claims nothing, which means no alumni — not "assume BYU".
    await applyBundleDelta(createClient(MIXED, null), SUB, BUNDLE, {});
    expect(importedIds()).toEqual([1, 3, 4, 6, 7]);
  });

  it("keeps an alum in a product role, and an alum recruiter", async () => {
    await applyBundleDelta(
      createClient([prospect(1, true, "alum_product"), prospect(4, true, "recruiter")], null),
      SUB, BUNDLE, {},
    );
    expect(importedIds()).toEqual([1, 4]);
  });

  it("never drops a prospect whose persona is unknown", async () => {
    // Dropping withholds a real person from a user's database, so an
    // unclassified prospect must fail toward keeping.
    await applyBundleDelta(
      createClient([prospect(6, true, null), prospect(8, true, "")], null),
      SUB, BUNDLE, {},
    );
    expect(importedIds()).toEqual([6, 8]);
  });
});

describe("cursor advances by rows READ, not rows applied", () => {
  it("does not stall when an entire chunk is filtered away", async () => {
    // The infinite-loop case. All three rows are alumni-only, so nothing is
    // applied — but the chunk was FULL, so the cursor must still advance past
    // them or the next call re-reads the identical rows forever.
    const allDropped = [
      prospect(10, true, "alum_other"),
      prospect(11, true, "alum_other"),
      prospect(12, true, "alum_other"),
    ];
    const result = await applyBundleDelta(createClient(allDropped, null), SUB, BUNDLE, {
      chunkSize: 3,
    });

    expect(importedIds()).toEqual([]);
    expect(result.nextCursor).toEqual({ phase: "apply", afterId: 12 });
  });

  it("still reaches the removal phase when a partial chunk is filtered to empty", async () => {
    // Two rows read, both dropped, chunk not full. The apply phase is
    // exhausted, so the next cursor must be the REMOVAL phase — keying that
    // decision off the filtered array would read as "nothing was there" and
    // skip removals entirely.
    const result = await applyBundleDelta(
      createClient([prospect(20, true, "alum_other"), prospect(21, true, "alum_other")], null),
      SUB, BUNDLE, { chunkSize: 50 },
    );
    expect(importedIds()).toEqual([]);
    expect(result.nextCursor).toEqual({ phase: "remove", afterId: 0 });
  });

  it("advances past a filtered row even when later rows are kept", async () => {
    const result = await applyBundleDelta(
      createClient([prospect(30, true, "alum_other"), prospect(31, false, "product_peer")], null),
      SUB, BUNDLE, { chunkSize: 2 },
    );
    expect(importedIds()).toEqual([31]);
    expect(result.nextCursor).toEqual({ phase: "apply", afterId: 31 });
  });
});

describe("affinity source", () => {
  it("reads public.users, not a caller-supplied claim", async () => {
    // user_metadata is user-writable through the Supabase client, so trusting
    // it would let anyone grant themselves the alumni prospects.
    const client = createClient(MIXED, "Brigham Young University");
    await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(importedIds()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("honours an explicit override without reading", async () => {
    // The seam the fast path and tests use. Positive control: the stored
    // school says BYU, so anything other than the override would keep all 7.
    await applyBundleDelta(createClient(MIXED, "Brigham Young University"), SUB, BUNDLE, {
      hasAlumniAffinity: false,
    });
    expect(importedIds()).toEqual([1, 3, 4, 6, 7]);
  });

  it("actually queries bundle_prospects with a cursor bound", async () => {
    // Guards the HARNESS. If the responder never matched the prospect query,
    // every assertion above would be comparing two empty arrays and passing.
    // Self-contained on purpose: beforeEach resets these counters, so reading
    // them without driving a sync here would measure nothing.
    await applyBundleDelta(createClient(MIXED, null), SUB, BUNDLE, {});
    expect(prospectSelects).toBeGreaterThan(0);
    expect(lastGtId).toBe(0);
  });
});

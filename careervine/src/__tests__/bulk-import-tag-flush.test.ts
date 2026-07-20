/**
 * CAR-158: the tag flush is the LAST write in importPeopleChunk's post-commit
 * region, and its reads throw (must()). By the time it runs the chunk's
 * contacts are already in the database, so an escaping error would make the
 * caller report failure for work that actually succeeded. It must degrade to a
 * per-person warning instead, matching the email and education flushes that
 * sit immediately above it.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { importPeopleChunk } from "@/lib/bulk-import";
import { bundleProspectPayloadV1Schema, payloadToMappedPerson } from "@/lib/bundle-payload";

// ── Programmable chained-builder mock (same shape as bulk-import-batching) ──

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (
  state: QueryState,
) => { data?: unknown; error?: { message: string } | null } | undefined;

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
      insert(p: unknown) { state.op = "insert"; state.payload = p; return builder; },
      update(p: unknown) { state.op = "update"; state.payload = p; return builder; },
      upsert(p: unknown, opts?: unknown) { state.op = "upsert"; state.payload = p; state.filters.push({ method: "upsertOpts", args: [opts] }); return builder; },
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
  return { client: { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient, calls };
}

const CTX = { bundleId: 1, bundleSlug: "apm-data-bundle", bundleVersion: 3 };

/** Tagged prospect; no experiences/education/emails keeps the flush isolated. */
const TAGGED = payloadToMappedPerson(
  bundleProspectPayloadV1Schema.parse({
    name: "Jane Doe",
    linkedin_url: "https://www.linkedin.com/in/janedoe",
    network_status: "prospect",
    tags: ["apm-2026"],
  }),
  CTX,
);

/** Same chunk, no tags — must never pick up a tag warning. */
const UNTAGGED = payloadToMappedPerson(
  bundleProspectPayloadV1Schema.parse({
    name: "Bob Roe",
    linkedin_url: "https://www.linkedin.com/in/bobroe",
    network_status: "bench",
  }),
  CTX,
);

/** Clean all-creates chunk; `tagsError` fails the tag read the flush depends on. */
function respondWith(opts: { tagsError?: string } = {}): Responder {
  let contactId = 100;
  return (state) => {
    if (state.table === "suppressed_imports") return { data: [] };
    if (state.table === "contacts" && state.op === "select") return { data: [] };
    if (state.table === "contacts" && state.op === "insert") {
      if (Array.isArray(state.payload)) {
        return {
          data: (state.payload as Array<{ linkedin_url: string | null }>).map((r) => ({
            id: ++contactId,
            linkedin_url: r.linkedin_url,
          })),
        };
      }
      return { data: { id: ++contactId } };
    }
    if (state.table === "tags" && state.op === "select") {
      if (opts.tagsError) return { data: null, error: { message: opts.tagsError } };
      return { data: [] };
    }
    if (state.table === "tags" && state.op === "insert") {
      const rows = state.payload as Array<{ name: string }>;
      return { data: rows.map((r, i) => ({ id: 900 + i, name: r.name })) };
    }
    return { data: [] };
  };
}

const IMPORT_OPTS = {
  mergePolicy: "bundle" as const,
  skipPhotos: true,
  noteLabel: 'Imported from data bundle "APM Data Bundle"',
};

describe("importPeopleChunk tag flush (CAR-158)", () => {
  it("still reports created contacts when the tag read fails, warning the tagged rows", async () => {
    const { client } = createMockClient(respondWith({ tagsError: "connection reset" }));

    const summary = await importPeopleChunk(
      client,
      "user-1",
      [{ mapped: TAGGED }, { mapped: UNTAGGED }],
      IMPORT_OPTS,
    );

    // The contacts committed before the flush ran — the chunk must own that.
    expect(summary.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(summary.results.every((r) => typeof r.contact_id === "number")).toBe(true);

    // Only the person whose tags were dropped hears about it.
    expect(summary.results[0].warnings).toContainEqual(
      expect.stringContaining("Tags not applied: connection reset"),
    );
    expect(summary.results[1].warnings.some((w) => w.includes("Tags not applied"))).toBe(false);
  });

  it("adds no tag warning when the flush succeeds", async () => {
    const { client, calls } = createMockClient(respondWith());

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: TAGGED }], IMPORT_OPTS);

    expect(summary.results[0].status).toBe("created");
    expect(summary.results[0].warnings.some((w) => w.includes("Tags not applied"))).toBe(false);
    expect(calls.filter((c) => c.table === "contact_tags" && c.op === "insert")).toHaveLength(1);
  });
});

/**
 * Deep-review regression pins for the CAR-146 data layer (PR #112):
 *
 * - deleteContact must not fail (or write a tombstone) when the post-delete
 *   survivor probe errors — the contact row is already gone at that point.
 * - findOrCreateSchool / findOrCreateLocation recover from the concurrent
 *   insert race (23505) by refetching the winner instead of failing the save.
 * - findOrCreateLocation's probe is limit(1)-guarded so historical duplicate
 *   NULL-tuple rows can't turn maybeSingle() into a permanent error.
 * - findOrCreateSchool reuses case variants ("byu" → "BYU") but verifies the
 *   ilike probe's candidates in JS, so a `*` in the name (a PostgREST
 *   wildcard that cannot be escaped) can't resolve to a different school.
 * - deleteAttachment issues no junction-table round-trips (ON DELETE CASCADE
 *   owns them since migration 20260711130000).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

interface Call {
  table: string;
  ops: Array<{ m: string; args: unknown[] }>;
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    respond: (_c: Call): { data: unknown; error: unknown } => ({ data: null, error: null }),
  };

  function makeBuilder(table: string) {
    const call: Call = { table, ops: [] };
    state.calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = (m: string) => (...args: unknown[]) => {
      call.ops.push({ m, args });
      return builder;
    };
    for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "ilike", "is", "in", "order", "limit", "range", "or", "not", "gte", "lt"]) {
      builder[m] = chain(m);
    }
    builder.single = async () => {
      call.ops.push({ m: "single", args: [] });
      return state.respond(call);
    };
    builder.maybeSingle = async () => {
      call.ops.push({ m: "maybeSingle", args: [] });
      return state.respond(call);
    };
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(state.respond(call)).then(onF, onR);
    return builder;
  }

  return { state, makeBuilder };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    from: (t: string) => h.makeBuilder(t),
    storage: {
      from: () => ({ remove: async () => ({ error: null }) }),
    },
  }),
}));

import { deleteContact, findOrCreateSchool, findOrCreateLocation } from "@/lib/data/contacts";
import { deleteAttachment } from "@/lib/data/attachments";

const fetchMock = vi.fn(async () => new Response("{}"));
vi.stubGlobal("fetch", fetchMock);

const ops = (c: Call) => c.ops.map((o) => o.m);
const callsTo = (table: string) => h.state.calls.filter((c) => c.table === table);

beforeEach(() => {
  h.state.calls = [];
  h.state.respond = () => ({ data: null, error: null });
  fetchMock.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("deleteContact tombstone bookkeeping (post-delete, best-effort)", () => {
  const deletedRow = {
    user_id: "u1",
    linkedin_url: "https://www.linkedin.com/in/jane-doe/",
    import_source: "pipeline",
  };

  it("still resolves — and skips the tombstone — when the survivor probe errors", async () => {
    h.state.respond = (c) => {
      if (c.table === "contacts" && ops(c).includes("delete")) return { data: deletedRow, error: null };
      if (c.table === "contacts" && ops(c).includes("maybeSingle"))
        return { data: null, error: { message: "transient", code: "XX000" } };
      return { data: null, error: null };
    };

    await expect(deleteContact(5)).resolves.toBeUndefined();
    // Errored probe must never be mistaken for "no survivor": no tombstone.
    expect(callsTo("suppressed_imports")).toHaveLength(0);
  });

  it("writes the tombstone when the probe cleanly finds no survivor", async () => {
    h.state.respond = (c) => {
      if (c.table === "contacts" && ops(c).includes("delete")) return { data: deletedRow, error: null };
      if (c.table === "contacts" && ops(c).includes("maybeSingle")) return { data: null, error: null };
      return { data: null, error: null };
    };

    await deleteContact(5);
    const tombstones = callsTo("suppressed_imports");
    expect(tombstones).toHaveLength(1);
    expect(ops(tombstones[0])).toContain("upsert");
  });

  it("skips the tombstone when a surviving duplicate still wants import refreshes", async () => {
    h.state.respond = (c) => {
      if (c.table === "contacts" && ops(c).includes("delete")) return { data: deletedRow, error: null };
      if (c.table === "contacts" && ops(c).includes("maybeSingle")) return { data: { id: 9 }, error: null };
      return { data: null, error: null };
    };

    await deleteContact(5);
    expect(callsTo("suppressed_imports")).toHaveLength(0);
  });
});

describe("find-or-create insert races", () => {
  // The school probe is a paginated ilike narrowing (rows array), not a
  // maybeSingle — the literal-name match is decided in JS.
  const isSchoolProbe = (c: Call) => c.table === "schools" && ops(c).includes("ilike");

  it("findOrCreateSchool refetches the winner on a 23505 unique violation", async () => {
    let probes = 0;
    h.state.respond = (c) => {
      if (isSchoolProbe(c)) {
        probes++;
        // First probe: no row yet. Refetch after the lost race: winner row.
        return probes === 1
          ? { data: [], error: null }
          : { data: [{ id: 7, name: "BYU Marriott" }], error: null };
      }
      if (c.table === "schools" && ops(c).includes("insert"))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      return { data: null, error: null };
    };

    await expect(findOrCreateSchool("BYU Marriott")).resolves.toEqual({ id: 7, name: "BYU Marriott" });
    expect(probes).toBe(2);
  });

  it("findOrCreateSchool rethrows non-unique-violation insert errors", async () => {
    h.state.respond = (c) => {
      if (isSchoolProbe(c)) return { data: [], error: null };
      if (c.table === "schools" && ops(c).includes("insert"))
        return { data: null, error: { code: "42501", message: "permission denied" } };
      return { data: null, error: null };
    };

    await expect(findOrCreateSchool("BYU")).rejects.toMatchObject({ code: "42501" });
  });

  it("findOrCreateSchool reuses a case-variant match: 'byu' resolves to 'BYU'", async () => {
    h.state.respond = (c) => {
      if (isSchoolProbe(c)) return { data: [{ id: 2, name: "BYU" }], error: null };
      return { data: null, error: null };
    };

    await expect(findOrCreateSchool("byu")).resolves.toEqual({ id: 2, name: "BYU" });
    // Reuse, not duplicate: no insert round-trip.
    expect(callsTo("schools").filter((c) => ops(c).includes("insert"))).toHaveLength(0);
  });

  it("findOrCreateSchool never resolves a '*' name to a wildcard-matched other school", async () => {
    // PostgREST rewrites `*` to `%`, and escapeIlike cannot neutralize it, so
    // the probe for "A*M" also returns rows like "ATM". Only a literal
    // case-insensitive match may be reused.
    h.state.respond = (c) => {
      if (isSchoolProbe(c)) return { data: [{ id: 5, name: "ATM" }], error: null };
      if (c.table === "schools" && ops(c).includes("insert"))
        return { data: { id: 9, name: "A*M" }, error: null };
      return { data: null, error: null };
    };

    await expect(findOrCreateSchool("A*M")).resolves.toEqual({ id: 9, name: "A*M" });
    const insert = callsTo("schools").find((c) => ops(c).includes("insert"));
    expect(insert?.ops.find((o) => o.m === "insert")?.args).toEqual([{ name: "A*M" }]);
  });

  it("findOrCreateLocation refetches the winner on a 23505 unique violation", async () => {
    let probes = 0;
    h.state.respond = (c) => {
      if (c.table === "locations" && ops(c).includes("maybeSingle")) {
        probes++;
        return probes === 1
          ? { data: null, error: null }
          : { data: { id: 3, city: "Provo", state: "Utah", country: "United States" }, error: null };
      }
      if (c.table === "locations" && ops(c).includes("insert"))
        return { data: null, error: { code: "23505", message: "duplicate key" } };
      return { data: null, error: null };
    };

    await expect(
      findOrCreateLocation({ city: "Provo", state: "Utah", country: "United States" }),
    ).resolves.toMatchObject({ id: 3 });
  });

  it("findOrCreateLocation probes with order+limit(1) so duplicate NULL-tuple rows can't error maybeSingle", async () => {
    h.state.respond = (c) => {
      if (c.table === "locations" && ops(c).includes("maybeSingle"))
        return { data: { id: 11, city: null, state: "California", country: "United States" }, error: null };
      return { data: null, error: null };
    };

    const row = await findOrCreateLocation({ city: null, state: "California", country: "United States" });
    expect(row).toMatchObject({ id: 11 });

    const probe = callsTo("locations")[0];
    const methods = ops(probe);
    expect(methods).toContain("order");
    expect(probe.ops.find((o) => o.m === "limit")?.args).toEqual([1]);
    // NULL components filter via .is(), not .eq()
    expect(probe.ops.find((o) => o.m === "is")?.args).toEqual(["city", null]);
    // No insert happened — the existing row was returned.
    expect(callsTo("locations")).toHaveLength(1);
  });
});

describe("deleteAttachment relies on ON DELETE CASCADE for junction cleanup", () => {
  it("issues only the attachments-row delete — no junction round-trips", async () => {
    h.state.respond = () => ({ data: null, error: null });

    await deleteAttachment(12, "u1/xyz_cv.pdf");

    expect(callsTo("contact_attachments")).toHaveLength(0);
    expect(callsTo("meeting_attachments")).toHaveLength(0);
    expect(callsTo("interaction_attachments")).toHaveLength(0);
    const rowDelete = callsTo("attachments");
    expect(rowDelete).toHaveLength(1);
    expect(ops(rowDelete[0])).toContain("delete");
  });
});

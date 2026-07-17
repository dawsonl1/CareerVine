/**
 * CAR-47: the import engine's chunk-level batching. One 50-prospect apply
 * chunk used to issue ~1,000 sequential queries and blow Vercel's 60s
 * function limit before inserting a single contact; these tests pin the
 * batched query profile (prefetches + bulk writes) and the fallbacks that
 * keep behavior identical when a prefetch misses or a bulk write fails.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { importPeopleChunk } from "@/lib/bulk-import";
import {
  bundleProspectPayloadV1Schema,
  payloadToMappedPerson,
} from "@/lib/bundle-payload";
import {
  prefetchCompanies,
  prefetchLocations,
  ensureCompanyLocations,
  chunkList,
} from "@/lib/company-helpers";
import { addTagsToContacts } from "@/lib/import-db-helpers";

// ── Programmable chained-builder mock (same shape as bundle-sync.test.ts) ──

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

const byTable = (calls: QueryState[], table: string, op?: QueryState["op"]) =>
  calls.filter((c) => c.table === table && (!op || c.op === op));

// ── Fixtures: real bundle payloads through the real adapter ────────────

const CTX = { bundleId: 1, bundleSlug: "apm-data-bundle", bundleVersion: 3 };

function mappedFromPayload(raw: unknown) {
  return payloadToMappedPerson(bundleProspectPayloadV1Schema.parse(raw), CTX);
}

const JANE = mappedFromPayload({
  name: "Jane Doe",
  linkedin_url: "https://www.linkedin.com/in/janedoe",
  headline: "APM @ Acme",
  network_status: "prospect",
  emails: [{ email: "jane@acme.com", source: "verified" }],
  location_raw: "Seattle, WA",
  experiences: [
    {
      title: "Associate Product Manager",
      company: { name: "Acme", linkedin_company_id: "111", universal_name: "acme" },
      is_current: true,
      location_raw: "Seattle, WA",
    },
  ],
  education: [{ school_name: "BYU", degree: "BS", field_of_study: "IS", start_year: 2022, end_year: 2026 }],
  tags: ["apm-2026"],
});

const BOB = mappedFromPayload({
  name: "Bob Roe",
  linkedin_url: "https://www.linkedin.com/in/bobroe",
  network_status: "bench",
  experiences: [
    // Same company as Jane (exercises the chunk cache) + one id-less company
    { title: "PM", company: { name: "Acme", linkedin_company_id: "111" }, is_current: false, end_month: "2024-05" },
    { title: "Analyst", company: { name: "Tiny Co" }, is_current: true, location_raw: "Seattle, WA" },
  ],
  education: [{ school_name: "BYU", degree: "BA", field_of_study: "Econ", start_year: 2018 }],
  tags: ["apm-2026", "bench"],
});

const ACME = { id: 10, name: "Acme", linkedin_company_id: "111", linkedin_url: null, universal_name: "acme", logo_url: null };
const TINY = { id: 11, name: "Tiny Co", linkedin_company_id: null, linkedin_url: null, universal_name: null, logo_url: null };
const SEATTLE = { id: 500, city: "Seattle", state: "Washington", country: "United States" };

/** Responder for a clean all-creates bundle chunk where every prefetch hits. */
function happyPathResponder(): { respond: Responder; nextContactId: () => number } {
  let contactId = 100;
  const respond: Responder = (state) => {
    if (state.table === "suppressed_imports") return { data: [] };
    if (state.table === "companies" && state.op === "select") {
      const inArgs = state.filters.find((f) => f.method === "in");
      if (inArgs && inArgs.args[0] === "linkedin_company_id") return { data: [ACME] };
      if (inArgs && inArgs.args[0] === "name") return { data: [TINY] };
      return { data: [] };
    }
    if (state.table === "locations" && state.op === "select") return { data: [SEATTLE] };
    if (state.table === "company_locations" && state.op === "upsert") return { data: null };
    if (state.table === "company_locations" && state.op === "select") return { data: [] };
    if (state.table === "schools" && state.op === "select") return { data: [{ id: 77, name: "BYU" }] };
    if (state.table === "contacts" && state.op === "select") return { data: [] }; // no existing contacts
    if (state.table === "contacts" && state.op === "insert") {
      // Bulk create (CAR-57) returns id + linkedin_url per row; the
      // single-object shape serves the per-row fallback path.
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
    if (state.table === "tags" && state.op === "select") return { data: [] };
    if (state.table === "tags" && state.op === "insert") {
      const rows = state.payload as Array<{ name: string }>;
      return { data: rows.map((r, i) => ({ id: 900 + i, name: r.name })) };
    }
    if (state.table === "contact_tags" && state.op === "select") return { data: [] };
    return { data: [] };
  };
  return { respond, nextContactId: () => contactId };
}

describe("importPeopleChunk batching (CAR-47)", () => {
  it("imports a bundle chunk with the batched query profile", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient(respond);

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
      noteLabel: 'Imported from data bundle "APM Data Bundle"',
    });

    expect(summary.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(summary.results.every((r) => typeof r.contact_id === "number")).toBe(true);

    // Contacts: ONE bulk insert for the whole chunk (CAR-57).
    const contactInserts = byTable(calls, "contacts", "insert");
    expect(contactInserts).toHaveLength(1);
    expect((contactInserts[0].payload as unknown[]).length).toBe(2);

    // Employment: ONE bulk insert across the chunk (jane 1 + bob 2).
    const empInserts = byTable(calls, "contact_companies", "insert");
    expect(empInserts).toHaveLength(1);
    expect((empInserts[0].payload as unknown[]).length).toBe(3);
    expect(summary.results[0].employment).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(summary.results[1].employment).toEqual({ inserted: 2, updated: 0, deleted: 0 });

    // Companies: one id-prefetch + one name-prefetch, NO per-company fallback.
    expect(byTable(calls, "companies", "select")).toHaveLength(2);
    expect(byTable(calls, "companies", "insert")).toHaveLength(0);

    // Locations: one prefetch select, no find-or-create.
    expect(byTable(calls, "locations", "select")).toHaveLength(1);
    expect(byTable(calls, "locations", "insert")).toHaveLength(0);

    // Offices: ONE bulk ignore-duplicates upsert + the all-offices load.
    const officeUpserts = byTable(calls, "company_locations", "upsert");
    expect(officeUpserts).toHaveLength(1);
    expect(Array.isArray(officeUpserts[0].payload)).toBe(true);
    expect(officeUpserts[0].filters.find((f) => f.method === "upsertOpts")?.args[0]).toMatchObject({
      onConflict: "company_id,location_id",
      ignoreDuplicates: true,
    });

    // Schools: one exact-name prefetch, no creation.
    expect(byTable(calls, "schools", "select")).toHaveLength(1);
    expect(byTable(calls, "schools", "insert")).toHaveLength(0);

    // Education: created contacts skip the existing-rows select; one bulk
    // ignore-duplicates upsert on the DB unique index (CAR-62).
    expect(byTable(calls, "contact_schools", "select")).toHaveLength(0);
    const eduUpserts = byTable(calls, "contact_schools", "upsert");
    expect(eduUpserts).toHaveLength(1);
    expect((eduUpserts[0].payload as unknown[]).length).toBe(2);
    expect(eduUpserts[0].filters.find((f) => f.method === "upsertOpts")?.args[0]).toEqual({
      onConflict: "contact_id,school_id,start_year",
      ignoreDuplicates: true,
    });

    // Emails: one bulk insert (only Jane has one).
    const emailInserts = byTable(calls, "contact_emails", "insert");
    expect(emailInserts).toHaveLength(1);
    expect((emailInserts[0].payload as unknown[]).length).toBe(1);

    // Tags: fixed-count batched pass for the whole chunk.
    expect(byTable(calls, "tags", "select")).toHaveLength(1);
    expect(byTable(calls, "tags", "insert")).toHaveLength(1);
    expect(byTable(calls, "contact_tags", "select")).toHaveLength(1);
    const linkInserts = byTable(calls, "contact_tags", "insert");
    expect(linkInserts).toHaveLength(1);
    // jane:apm-2026 + bob:apm-2026 + bob:bench
    expect((linkInserts[0].payload as unknown[]).length).toBe(3);
  });

  it("fails the chunk when the suppression read errors (never silently re-imports tombstones, CAR-139)", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      if (state.table === "suppressed_imports") return { data: null, error: { message: "connection reset" } };
      return respond(state);
    });

    await expect(
      importPeopleChunk(client, "user-1", [{ mapped: JANE }], {
        mergePolicy: "bundle",
        skipPhotos: true,
        noteLabel: "Imported from data bundle",
      }),
    ).rejects.toThrow(/Suppression read failed/);
    // Nothing was imported past the failed tombstone check.
    expect(byTable(calls, "contacts", "insert")).toHaveLength(0);
  });

  it("falls back to findOrCreateCompany when the prefetch misses", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      // Simulate a company that is NOT in the DB at prefetch time.
      if (state.table === "companies" && state.op === "select") {
        const hasIn = state.filters.some((f) => f.method === "in");
        if (hasIn) return { data: [] }; // both prefetches miss
        return { data: null }; // fallback chain lookups (maybeSingle/ilike) miss too
      }
      if (state.table === "companies" && state.op === "insert") return { data: ACME };
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results[0].status).toBe("created");
    // The fallback chain ran: at least the prefetch selects plus the
    // find-or-create lookups and one insert.
    expect(byTable(calls, "companies", "insert")).toHaveLength(1);
  });

  it("keeps two same-school degrees when start_year is NULL (NULLS-distinct index)", async () => {
    const nullYear = mappedFromPayload({
      name: "Dee Major",
      linkedin_url: "https://www.linkedin.com/in/deemajor-nullyear",
      network_status: "prospect",
      education: [
        { school_name: "BYU", degree: "BS", field_of_study: "IS" },
        { school_name: "BYU", degree: "MISM", field_of_study: "IS" },
      ],
    });
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient(respond);

    await importPeopleChunk(client, "user-1", [{ mapped: nullYear }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    // Both persist — NULL start_year rows don't collide in the DB, so the
    // in-code key must not collapse them on school alone (CAR-62 review).
    const eduUpserts = byTable(calls, "contact_schools", "upsert");
    expect(eduUpserts).toHaveLength(1);
    const rows = eduUpserts[0].payload as Array<{ degree: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.degree).sort()).toEqual(["BS", "MISM"]);
  });

  it("dedupes same-school same-start-year education to the DB unique key (double major)", async () => {
    const doubleMajor = mappedFromPayload({
      name: "Dee Major",
      linkedin_url: "https://www.linkedin.com/in/deemajor",
      network_status: "prospect",
      education: [
        { school_name: "BYU", degree: "BS", field_of_study: "IS", start_year: 2022 },
        { school_name: "BYU", degree: "Minor", field_of_study: "CS", start_year: 2022 },
        { school_name: "BYU", degree: "MISM", field_of_study: "IS", start_year: 2026 },
      ],
    });
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient(respond);

    await importPeopleChunk(client, "user-1", [{ mapped: doubleMajor }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    // Two distinct (school_id, start_year) keys → two rows, not three; the
    // old degree-inclusive key let the Minor through and poisoned the bulk
    // insert against the DB unique index (CAR-62).
    const eduUpserts = byTable(calls, "contact_schools", "upsert");
    expect(eduUpserts).toHaveLength(1);
    const rows = eduUpserts[0].payload as Array<{ school_id: number; start_year: number | null; degree: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.start_year).sort()).toEqual([2022, 2026]);
  });

  it("degrades bulk education/email inserts to per-row on failure", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contact_schools" && state.op === "upsert") {
        return { error: { message: "bulk failed" } };
      }
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results.map((r) => r.status)).toEqual(["created", "created"]);
    // 1 failed bulk upsert + 2 per-row insert fallbacks
    expect(byTable(calls, "contact_schools", "upsert")).toHaveLength(1);
    const eduInserts = byTable(calls, "contact_schools", "insert");
    expect(eduInserts).toHaveLength(2);
    expect(eduInserts.every((c) => !Array.isArray(c.payload))).toBe(true);
  });

  it("merges tags when two chunk entries resolve to the same contact", async () => {
    // JANE matches by URL; JANE_ALT matches the same contact via
    // public_identifier. The second entry must not clobber the first's tags.
    const JANE_ALT = mappedFromPayload({
      name: "Jane Doe",
      linkedin_url: "https://www.linkedin.com/in/janedoe-alt",
      public_identifier: "janedoe",
      network_status: "prospect",
      tags: ["second-tag"],
    });
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts" && state.op === "select") {
        const inArgs = state.filters.find((f) => f.method === "in");
        const contactRow = {
          id: 42, name: "Jane Doe", linkedin_url: JANE.linkedin_url,
          public_identifier: "janedoe", persona: null, network_status: "prospect",
          location_id: 500, headline: null, photo_url: null,
        };
        if (inArgs && (inArgs.args[0] === "linkedin_url" || inArgs.args[0] === "public_identifier")) {
          return { data: [contactRow] };
        }
        return { data: [] };
      }
      if (state.table === "contact_schools" && state.op === "select") return { data: [] };
      if (state.table === "contact_companies" && state.op === "select") return { data: [] };
      if (state.table === "contact_emails" && state.op === "select") return { data: [] };
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: JANE_ALT }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results.map((r) => r.status)).toEqual(["updated", "updated"]);
    const linkInserts = byTable(calls, "contact_tags", "insert");
    expect(linkInserts).toHaveLength(1);
    // apm-2026 (JANE) + second-tag (JANE_ALT) both land on contact 42.
    expect(linkInserts[0].payload as unknown[]).toHaveLength(2);
  });

  it("checks existing education (but not user_id) on the update path", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts" && state.op === "select") {
        // Jane already exists for this user.
        const inArgs = state.filters.find((f) => f.method === "in");
        if (inArgs && inArgs.args[0] === "linkedin_url") {
          return {
            data: [{
              id: 42, name: "Jane Doe", linkedin_url: JANE.linkedin_url,
              public_identifier: "janedoe", persona: null, network_status: "prospect",
              location_id: 500, headline: null, photo_url: null,
            }],
          };
        }
        return { data: [] };
      }
      if (state.table === "contact_schools" && state.op === "select") return { data: [] };
      if (state.table === "contact_companies" && state.op === "select") return { data: [] };
      if (state.table === "contact_emails" && state.op === "select") return { data: [] };
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results[0].status).toBe("updated");
    // Education existing-rows check ran for the pre-existing contact…
    expect(byTable(calls, "contact_schools", "select")).toHaveLength(1);
    // …but the old per-contact `select user_id` roundtrip is gone: every
    // contacts select is one of the two batch lookups (url / pid).
    const contactSelects = byTable(calls, "contacts", "select");
    expect(
      contactSelects.every((c) =>
        c.filters.some((f) => f.method === "in" && (f.args[0] === "linkedin_url" || f.args[0] === "public_identifier")),
      ),
    ).toBe(true);
  });
});

describe("bulk create path (CAR-57)", () => {
  it("degrades a failed bulk contact insert to per-row, keeping statuses accurate", async () => {
    const { respond } = happyPathResponder();
    let singleId = 200;
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts" && state.op === "insert") {
        return Array.isArray(state.payload)
          ? { error: { message: "bulk failed" } }
          : { data: { id: ++singleId } };
      }
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(summary.results.map((r) => r.contact_id)).toEqual([201, 202]);
    // 1 failed bulk + 2 per-row fallbacks
    const contactInserts = byTable(calls, "contacts", "insert");
    expect(contactInserts).toHaveLength(3);
    expect(contactInserts.slice(1).every((c) => !Array.isArray(c.payload))).toBe(true);
  });

  it("recovers a failed per-row insert by refetching and merging as an update", async () => {
    const { respond } = happyPathResponder();
    const janeRow = {
      id: 42, name: "Jane Doe", linkedin_url: JANE.linkedin_url,
      public_identifier: "janedoe", persona: null, network_status: "prospect",
      location_id: 500, headline: null, photo_url: null,
    };
    let singleId = 200;
    const { client, calls } = createMockClient((state) => {
      if (state.table === "contacts" && state.op === "insert") {
        if (Array.isArray(state.payload)) return { error: { message: "bulk failed" } };
        // Jane's single-row insert fails (simulated racing writer)…
        return (state.payload as { linkedin_url: string | null }).linkedin_url === JANE.linkedin_url
          ? { error: { message: "row failed" } }
          : { data: { id: ++singleId } };
      }
      // …and the refetch finds the contact the racer created.
      if (state.table === "contacts" && state.op === "select") {
        const refetch = state.filters.find((f) => f.method === "eq" && f.args[0] === "linkedin_url");
        if (refetch) return { data: refetch.args[1] === JANE.linkedin_url ? [janeRow] : [] };
        return { data: [] };
      }
      if (state.table === "contact_schools" && state.op === "select") return { data: [] };
      if (state.table === "contact_companies" && state.op === "select") return { data: [] };
      if (state.table === "contact_emails" && state.op === "select") return { data: [] };
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results.map((r) => r.status)).toEqual(["updated", "created"]);
    expect(summary.results[0].contact_id).toBe(42);
    expect(summary.results[1].contact_id).toBe(201);
    // Jane took the update path — an applied_patch is recorded for
    // bundle fingerprint bookkeeping, exactly like a normal update.
    expect(summary.results[0].applied_patch).toBeDefined();
    expect(byTable(calls, "contacts", "update")).toHaveLength(1);
  });

  it("isolates a per-row insert failure with no recoverable contact to that person", async () => {
    const { respond } = happyPathResponder();
    let singleId = 200;
    const { client } = createMockClient((state) => {
      if (state.table === "contacts" && state.op === "insert") {
        if (Array.isArray(state.payload)) return { error: { message: "bulk failed" } };
        return (state.payload as { linkedin_url: string | null }).linkedin_url === JANE.linkedin_url
          ? { error: { message: "malformed row" } }
          : { data: { id: ++singleId } };
      }
      return respond(state); // refetch misses (contacts selects return [])
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results.map((r) => r.status)).toEqual(["error", "created"]);
    expect(summary.results[0].error).toBe("malformed row");
    expect(summary.results[1].contact_id).toBe(201);
  });

  it("degrades a failed bulk employment insert to per-person, isolating the bad person", async () => {
    const { respond } = happyPathResponder();
    const { client, calls } = createMockClient((state) => {
      // The chunk-wide insert (3 rows) and Bob's per-person rows (2) fail;
      // Jane's single row lands.
      if (state.table === "contact_companies" && state.op === "insert") {
        return (state.payload as unknown[]).length >= 2 ? { error: { message: "emp failed" } } : { data: null };
      }
      return respond(state);
    });

    const summary = await importPeopleChunk(client, "user-1", [{ mapped: JANE }, { mapped: BOB }], {
      mergePolicy: "bundle",
      skipPhotos: true,
    });

    expect(summary.results[0].status).toBe("created");
    expect(summary.results[0].employment).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(summary.results[1].status).toBe("error");
    expect(summary.results[1].error).toContain("Employment insert failed");
    // 1 failed bulk + 2 per-person fallbacks
    expect(byTable(calls, "contact_companies", "insert")).toHaveLength(3);
    // Education skipped for the errored person — only Jane's row flushes.
    const eduUpserts = byTable(calls, "contact_schools", "upsert");
    expect(eduUpserts).toHaveLength(1);
    expect((eduUpserts[0].payload as unknown[]).length).toBe(1);
  });
});

describe("prefetch helpers (CAR-47)", () => {
  it("prefetchCompanies: ids and id-less names, never name-prefetching id-bearing inputs", async () => {
    const { client, calls } = createMockClient((state) => {
      const inArgs = state.filters.find((f) => f.method === "in");
      if (inArgs?.args[0] === "linkedin_company_id") return { data: [ACME] };
      if (inArgs?.args[0] === "name") return { data: [TINY] };
      return { data: [] };
    });

    const result = await prefetchCompanies(client, [
      { name: "Acme", linkedin_company_id: "111" },
      { name: "Tiny Co" },
    ]);

    expect(result.byId.get("111")).toMatchObject({ id: 10 });
    expect(result.byName.get("tiny co")).toMatchObject({ id: 11 });
    const nameQuery = byTable(calls, "companies", "select").find((c) =>
      c.filters.some((f) => f.method === "in" && f.args[0] === "name"),
    );
    // Only the id-less input is name-prefetched (id-bearing must keep the claim path).
    expect(nameQuery?.filters.find((f) => f.method === "in")?.args[1]).toEqual(["Tiny Co"]);
  });

  it("prefetchCompanies: url/universal-bearing id-less inputs are NOT name-prefetched", async () => {
    // A name-prefetch hit would outrank findOrCreateCompany's linkedin_url /
    // universal_name matchers — those inputs must skip the shortcut entirely.
    const { client, calls } = createMockClient(() => ({ data: [] }));
    await prefetchCompanies(client, [
      { name: "Apex", linkedin_url: "https://www.linkedin.com/company/apex-labs" },
      { name: "Beta Corp", universal_name: "beta-corp" },
      { name: "Pure Name Co" },
    ]);
    const nameQuery = byTable(calls, "companies", "select").find((c) =>
      c.filters.some((f) => f.method === "in" && f.args[0] === "name"),
    );
    expect(nameQuery?.filters.find((f) => f.method === "in")?.args[1]).toEqual(["Pure Name Co"]);
  });

  it("prefetchLocations: matches only exact (city, state, country) triples", async () => {
    const { client } = createMockClient(() => ({
      data: [SEATTLE, { id: 501, city: "Seattle", state: null, country: "Australia" }],
    }));
    const map = await prefetchLocations(client, [
      { city: "Seattle", state: "Washington", country: "United States" },
    ]);
    expect(map.get("Seattle|Washington|United States")).toEqual({ id: 500 });
    expect(map.size).toBe(1); // the Australian row didn't match any wanted triple
  });

  it("ensureCompanyLocations: bulk upsert failure degrades to per-row", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "company_locations" && state.op === "upsert") {
        return Array.isArray(state.payload) ? { error: { message: "boom" } } : { data: null };
      }
      return { data: [] };
    });
    await ensureCompanyLocations(client, [
      { company_id: 1, location_id: 2 },
      { company_id: 3, location_id: 4 },
    ]);
    // 1 failed bulk + 2 per-row
    expect(byTable(calls, "company_locations", "upsert")).toHaveLength(3);
  });

  it("chunkList bounds .in() list sizes", () => {
    expect(chunkList([...Array(250).keys()])).toHaveLength(3);
    expect(chunkList([], 100)).toHaveLength(0);
  });
});

describe("addTagsToContacts (CAR-47)", () => {
  it("runs a fixed query profile for many contacts and dedupes/normalizes", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "tags" && state.op === "select") return { data: [{ id: 1, name: "apm-2026" }] };
      if (state.table === "tags" && state.op === "insert") {
        return { data: (state.payload as Array<{ name: string }>).map((r, i) => ({ id: 50 + i, name: r.name })) };
      }
      if (state.table === "contact_tags" && state.op === "select") return { data: [{ contact_id: 7, tag_id: 1 }] };
      return { data: [] };
    });

    await addTagsToContacts(client, "user-1", new Map([
      [7, ["APM-2026", "apm-2026", " Bench "]], // dupes + case + whitespace
      [8, ["apm-2026"]],
    ]));

    expect(byTable(calls, "tags", "select")).toHaveLength(1);
    const tagInserts = byTable(calls, "tags", "insert");
    expect(tagInserts).toHaveLength(1);
    expect(tagInserts[0].payload).toEqual([{ name: "bench", user_id: "user-1" }]);
    expect(byTable(calls, "contact_tags", "select")).toHaveLength(1);
    const linkInserts = byTable(calls, "contact_tags", "insert");
    expect(linkInserts).toHaveLength(1);
    // 7:bench + 8:apm-2026 (7:apm-2026 already linked)
    expect((linkInserts[0].payload as unknown[]).length).toBe(2);
  });

  it("degrades a failed bulk link insert to per-row", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "tags" && state.op === "select") return { data: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
      if (state.table === "contact_tags" && state.op === "select") return { data: [] };
      if (state.table === "contact_tags" && state.op === "insert") {
        return Array.isArray(state.payload) ? { error: { message: "boom" } } : { data: null };
      }
      return { data: [] };
    });

    await addTagsToContacts(client, "user-1", new Map([[7, ["a", "b"]]]));
    // 1 failed bulk + 2 per-row
    expect(byTable(calls, "contact_tags", "insert")).toHaveLength(3);
  });
});

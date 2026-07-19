/**
 * CAR-155 (F9): the contacts write chokepoint.
 *
 * 1. Source scan — no `.from("contacts").insert/.update/.upsert` exists
 *    outside src/lib/data/contacts.ts plus a justified allowlist of
 *    metadata-only writers. Every contact create/update that can carry
 *    linkedin_url or location_id funnels through createContact /
 *    createContacts / updateContact, where canonicalization runs.
 * 2. Behavior — the chokepoint canonicalizes linkedin_url on insert and
 *    update, and the canonical locations find-or-create normalizes inside
 *    (idempotently), so 'CA' and 'California' resolve to one row from every
 *    writer.
 * 3. Parity — formatting variants (www-less, trailing slash, uppercase)
 *    store identical values through every chokepoint entry. Because the scan
 *    in (1) proves all surfaces (web forms, extension import, MCP, admin,
 *    bulk/bundle pipelines) reach the table only through these functions,
 *    function-level parity is surface-level parity.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 1. Source scan ─────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");

// No /g flag: RegExp.test with /g is stateful (lastIndex) and would skip files.
const CONTACT_WRITE = /\.from\((["'`])contacts\1\)\s*\.\s*(insert|update|upsert)/;

/**
 * Files (relative to src/) allowed to write the contacts table directly.
 * Everything here is metadata-only — none of these writes can carry
 * linkedin_url or location_id. Adding a file requires a justification.
 */
const ALLOWLIST: Record<string, string> = {
  "lib/data/contacts.ts":
    "THE chokepoint module itself (createContact/createContacts/updateContact) plus network-tier activation metadata",
  "lib/data/follow-ups.ts": "reach-out snooze / skip / suggestion-cooldown metadata",
  "mcp/lib/db.ts":
    "network_status / stage_override metadata behind assertContactOwned; activateContactIfDormant needs a conditional .in() filter the chokepoint does not express",
  "lib/company-queries.ts": "network_status / stage_override metadata",
  "lib/gmail.ts": "email sync watermark + reply-based activation metadata",
  "lib/import-db-helpers.ts": "photo_url after R2 storage upload",
  "lib/apify/scrape-service.ts": "scrape failure counters",
  "app/api/contacts/[id]/photo/route.ts": "photo_url upload/delete",
  "app/api/contacts/check-duplicate/route.ts": "contact_status lazy re-derivation",
};

describe("contacts write chokepoint scan", () => {
  const files = fg.sync("**/*.{ts,tsx}", {
    cwd: srcDir,
    absolute: true,
    ignore: ["**/__tests__/**", "**/*.test.*"],
  });

  it("no out-of-band contacts insert/update/upsert exists outside the allowlist", () => {
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      if (!CONTACT_WRITE.test(readFileSync(f, "utf8"))) continue;
      const rel = path.relative(srcDir, f);
      if (!(rel in ALLOWLIST)) offenders.push(rel);
    }
    expect(
      offenders,
      "contacts writes must go through createContact/createContacts/updateContact in src/lib/data/contacts.ts (CAR-155) — or add a justified ALLOWLIST entry for a metadata-only write",
    ).toEqual([]);
  });

  it("every allowlist entry is live (no stale grandfathering)", () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => {
      try {
        return !CONTACT_WRITE.test(readFileSync(path.join(srcDir, rel), "utf8"));
      } catch {
        return true; // file gone
      }
    });
    expect(stale, "remove allowlist entries whose direct writes no longer exist").toEqual([]);
  });

  // A write through a VARIABLE table name (.from(table).insert) is invisible
  // to the literal scan above, so dynamic-table writers are enumerated
  // separately and must carry their own runtime refusal of the contacts
  // table (CAR-155 deep-review fix).
  const DYNAMIC_WRITE = /(?<!Array)(?<!Buffer)\.from\(\s*[^"'`\s)][^)]*\)\s*\.\s*(insert|update|upsert)/;
  const DYNAMIC_ALLOWLIST: Record<string, string> = {
    "lib/bundle-fast-apply.ts":
      "generic child-row bulkInsert (contact_companies/emails/bundle link+state); runtime-asserts table !== 'contacts'",
  };

  it("every dynamic-table write is enumerated and runtime-guards the contacts table", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!DYNAMIC_WRITE.test(readFileSync(f, "utf8"))) continue;
      const rel = path.relative(srcDir, f);
      if (!(rel in DYNAMIC_ALLOWLIST)) offenders.push(rel);
    }
    expect(
      offenders,
      "dynamic-table Postgres writes evade the literal contacts scan — add a runtime table !== 'contacts' assertion and a justified DYNAMIC_ALLOWLIST entry",
    ).toEqual([]);

    for (const rel of Object.keys(DYNAMIC_ALLOWLIST)) {
      const content = readFileSync(path.join(srcDir, rel), "utf8");
      expect(DYNAMIC_WRITE.test(content), `${rel}: stale DYNAMIC_ALLOWLIST entry`).toBe(true);
      expect(
        /table === "contacts"/.test(content),
        `${rel}: dynamic writer must runtime-refuse the contacts table`,
      ).toBe(true);
    }
  });
});

// ── 2 + 3. Chokepoint behavior on a recording client ───────────────────

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
  createSupabaseBrowserClient: () => ({ from: (t: string) => h.makeBuilder(t) }),
}));

import { createContact, createContacts, updateContact } from "@/lib/data/contacts";
import { findOrCreateLocation } from "@/lib/data/locations";
import { normalizeParsedLocation } from "@/lib/location-normalizer";

const writeArg = (table: string, op: string) => {
  const call = h.state.calls.find((c) => c.table === table && c.ops.some((o) => o.m === op));
  return call?.ops.find((o) => o.m === op)?.args[0];
};

beforeEach(() => {
  h.state.calls = [];
  h.state.respond = () => ({ data: {}, error: null });
});

describe("linkedin_url canonicalization inside the chokepoint", () => {
  const VARIANTS = [
    "linkedin.com/in/Jane-Doe/", // www-less + trailing slash + uppercase
    "https://www.linkedin.com/in/jane-doe", // already canonical
    "http://LinkedIn.com/in/jane-doe?utm=x", // scheme/case/query variants
  ];
  const CANONICAL = "https://www.linkedin.com/in/jane-doe";

  it("createContact stores the identical canonical value for every formatting variant (parity)", async () => {
    for (const url of VARIANTS) {
      h.state.calls = [];
      await createContact({ user_id: "u1", name: "Jane", linkedin_url: url });
      expect((writeArg("contacts", "insert") as { linkedin_url: string }).linkedin_url).toBe(CANONICAL);
    }
  });

  it("updateContact canonicalizes too, and applies userId scoping when given", async () => {
    await updateContact(7, { linkedin_url: "linkedin.com/in/Jane-Doe/" }, { userId: "u1" });
    const call = h.state.calls.find((c) => c.table === "contacts")!;
    expect((writeArg("contacts", "update") as { linkedin_url: string }).linkedin_url).toBe(CANONICAL);
    expect(call.ops.filter((o) => o.m === "eq").map((o) => o.args)).toEqual([
      ["id", 7],
      ["user_id", "u1"],
    ]);
  });

  it("createContacts canonicalizes every row of a bulk insert", async () => {
    h.state.respond = () => ({ data: [], error: null });
    await createContacts([
      { user_id: "u1", name: "A", linkedin_url: "linkedin.com/in/AA/" },
      { user_id: "u1", name: "B", linkedin_url: "https://www.linkedin.com/in/bb" },
    ]);
    const rows = writeArg("contacts", "insert") as Array<{ linkedin_url: string }>;
    expect(rows.map((r) => r.linkedin_url)).toEqual([
      "https://www.linkedin.com/in/aa",
      "https://www.linkedin.com/in/bb",
    ]);
  });

  it("keeps non-LinkedIn input trimmed + slash-stripped (matching the DB tidy trigger), collapses empty to null, passes explicit null through", async () => {
    await createContact({ user_id: "u1", name: "X", linkedin_url: "  not a linkedin url  " });
    expect((writeArg("contacts", "insert") as { linkedin_url: string }).linkedin_url).toBe("not a linkedin url");

    // Trailing slashes are stripped so the app-computed value always equals
    // what the BEFORE INSERT tidy trigger stores (CAR-155 deep-review fix).
    h.state.calls = [];
    await createContact({ user_id: "u1", name: "X", linkedin_url: "https://example.com/foo/" });
    expect((writeArg("contacts", "insert") as { linkedin_url: string }).linkedin_url).toBe("https://example.com/foo");

    h.state.calls = [];
    await createContact({ user_id: "u1", name: "Y", linkedin_url: "   " });
    expect((writeArg("contacts", "insert") as { linkedin_url: null }).linkedin_url).toBeNull();

    h.state.calls = [];
    await updateContact(3, { linkedin_url: null });
    expect((writeArg("contacts", "update") as { linkedin_url: null }).linkedin_url).toBeNull();

    h.state.calls = [];
    await updateContact(3, { notes: "no url key" });
    expect(writeArg("contacts", "update")).not.toHaveProperty("linkedin_url");
  });
});

describe("location normalization inside findOrCreateLocation", () => {
  it("normalizes 'CA' to 'California' so raw variants resolve to one row", async () => {
    await findOrCreateLocation({ city: "san francisco", state: "CA", country: null });
    const probe = h.state.calls.find((c) => c.table === "locations")!;
    expect(probe.ops.filter((o) => o.m === "eq").map((o) => o.args)).toEqual([
      ["city", "San Francisco"],
      ["state", "California"],
      ["country", "United States"],
    ]);
  });

  it("normalization is idempotent — already-normalized pipeline inputs pass through unchanged", () => {
    const once = normalizeParsedLocation({ city: "provo", state: "ut", country: null });
    const twice = normalizeParsedLocation({ city: once.city, state: once.state, country: once.country });
    expect({ city: twice.city, state: twice.state, country: twice.country }).toEqual({
      city: once.city,
      state: once.state,
      country: once.country,
    });
    expect(once.state).toBe("Utah");
  });

  it("returns null (no row) when nothing normalizes out of the input", async () => {
    expect(await findOrCreateLocation({ city: null, state: null, country: null })).toBeNull();
    expect(h.state.calls.filter((c) => c.table === "locations")).toEqual([]);
  });
});

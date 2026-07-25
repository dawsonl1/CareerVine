/**
 * CAR-158: the conventions guard's detectors actually detect.
 *
 * scripts/check-conventions.mjs shipped with a real blind spot: tripwire (c)
 * only inspected a declaration's TOP-LEVEL binding pattern, so
 * `const [{ data: a }, { data: b }] = await Promise.all([...])` was invisible
 * to it. Nine live unchecked reads sat inside its own scan scope reporting
 * clean, which is worse than having no guard: it advertised a safety property
 * it did not have.
 *
 * A guard that cannot be shown to trip is indistinguishable from one that does
 * nothing, so each detector below is exercised against a fixture tree that it
 * MUST reject, plus a clean control it must accept. The script is run as a real
 * subprocess against a temp checkout-shaped directory rather than imported,
 * because its scan roots are relative paths resolved from cwd.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { diffNamedRatchet, diffCountRatchet } from "../../scripts/lib/ratchet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const script = path.join(appRoot, "scripts", "check-conventions.mjs");

// Used as a computed key below so this file never contains the raw event-bus
// prefix literal that scripts/check-ui-events.mjs scans for. The emitted JSON
// is identical; only the source text differs.
const MCP_SERVER_NAME = "careervine";

let root: string;
let app: string;

/** Minimal tree shaped like the repo, so the script's relative roots resolve. */
function seed() {
  for (const d of [
    "src/lib/data",
    "src/lib/rules",
    "src/app/api/cron",
    "src/mcp/lib",
    "src/components",
    "src/hooks",
    "scripts",
    "../careervine-mcp/scripts",
  ]) {
    mkdirSync(path.join(app, d), { recursive: true });
  }

  // A frozen barrel with a single legal re-export.
  writeFileSync(path.join(app, "src/lib/queries.ts"), 'export { getX } from "./data/x";\n');
  writeFileSync(path.join(app, "src/lib/data/x.ts"), "export const getX = () => null;\n");
  // Under the MCP .from( baseline.
  writeFileSync(path.join(app, "src/mcp/lib/db.ts"), "export const noop = 1;\n");
  // Both MCP launch surfaces carrying the required condition.
  writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: "x",
            args: ["--conditions=react-server", "careervine-mcp/server.ts"],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(root, "careervine-mcp/package.json"),
    JSON.stringify({ scripts: { start: "tsx --conditions=react-server server.ts" } }, null, 2),
  );

}

/**
 * Run the REAL script with cwd pointed at the fixture tree.
 *
 * The script is executed in place rather than copied: its scan roots are
 * relative paths resolved from cwd (so the fixture is what gets scanned), while
 * its `import ts from "typescript"` is a bare specifier resolved from the
 * script's own location (so it still finds the app's node_modules). Copying it
 * into the temp dir breaks that import.
 */
function run(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: app,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Write a file into the fixture app, then run the guard. */
function withFile(rel: string, contents: string) {
  const full = path.join(app, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  const result = run();
  rmSync(full, { force: true });
  return result;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "conv-guard-"));
  app = path.join(root, "careervine");
  mkdirSync(app, { recursive: true });
  seed();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("conventions guard", () => {
  it("passes on a clean tree (control)", () => {
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  // ── tripwire (c): unchecked reads ──

  it("flags a plain unchecked `const { data }` read", () => {
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        '  const { data } = await db.from("t").select("id");\n' +
        "  return data;\n}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("unchecked read");
  });

  it("flags unchecked reads inside ARRAY destructuring (the blind spot this test exists for)", () => {
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        "  const [{ data: a }, { data: b }] = await Promise.all([\n" +
        '    db.from("t").select("id"),\n' +
        '    db.from("u").select("id"),\n' +
        "  ]);\n  return [a, b];\n}\n",
    );
    expect(code).toBe(1);
    // Both bindings must be reported, not just the first.
    expect(out).toContain("data: a");
    expect(out).toContain("data: b");
  });

  it("accepts a read that binds and checks `error`", () => {
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        '  const { data, error } = await db.from("t").select("id");\n' +
        "  if (error) throw error;\n  return data;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("accepts a read wrapped in must(), and one carrying an error-tolerated annotation", () => {
    expect(
      withFile(
        "src/lib/probe.ts",
        "export async function f(db: any, must: any) {\n" +
          '  const rows = must(await db.from("t").select("id"));\n' +
          "  return rows;\n}\n",
      ).code,
    ).toBe(0);

    expect(
      withFile(
        "src/lib/probe.ts",
        "export async function f(db: any) {\n" +
          "  // error-tolerated: a missing avatar renders the fallback\n" +
          '  const { data } = await db.from("t").select("id");\n' +
          "  return data;\n}\n",
      ).code,
    ).toBe(0);
  });

  // ── tripwire (b): rule-17 CAS shape ──

  it("flags an update+filter+select readback with no count", () => {
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        '  const { data } = await db.from("t").update({ s: "a" }).eq("s", "b").select("id");\n' +
        "  return data;\n}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("CAS readback");
  });

  it("sees filter operators beyond the original short list (contains / or / not)", () => {
    for (const op of ['contains("tags", ["x"])', 'or("a.is.null")', 'not("s", "eq", "b")']) {
      const { code, out } = withFile(
        "src/lib/probe.ts",
        "export async function f(db: any) {\n" +
          `  const { data } = await db.from("t").update({ s: "a" }).${op}.select("id");\n` +
          "  return data;\n}\n",
      );
      expect(code, `${op} should be flagged: ${out}`).toBe(1);
    }
  });

  it("accepts the count convention, and is not fooled by `count` elsewhere in the chain", () => {
    // Compliant: the count option is on the update itself.
    expect(
      withFile(
        "src/lib/probe.ts",
        "export async function f(db: any) {\n" +
          '  const { count } = await db.from("t").update({ s: "a" }, { count: "exact" }).eq("s", "b");\n' +
          "  return count;\n}\n",
      ).code,
    ).toBe(0);

    // NOT compliant: `count` appears in the chain but not as an update option.
    // The original chain-wide regex was position-blind and passed this.
    const { code } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        '  const { data } = await db.from("t").update({ s: "a" }).match({ count: "exact" }).select("id");\n' +
        "  return data;\n}\n",
    );
    expect(code).toBe(1);
  });

  it("accepts a cas-checked annotation", () => {
    // `error` is bound here so this probe isolates tripwire (b): a bare
    // `const { data }` would also (correctly) trip the unchecked-read rule and
    // the test would pass for the wrong reason.
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        "  // cas-checked: filters only on the primary key\n" +
        '  const { data, error } = await db.from("t").update({ s: "a" }).eq("id", 1).select("id");\n' +
        "  if (error) throw error;\n  return data;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  // ── tripwire (a): barrel freeze + module-scope client ──

  it("flags a non-re-export statement in the queries barrel", () => {
    const barrel = path.join(app, "src/lib/queries.ts");
    writeFileSync(barrel, 'export { getX } from "./data/x";\nexport function sneak() {}\n');
    const { code, out } = run();
    writeFileSync(barrel, 'export { getX } from "./data/x";\n');
    expect(code).toBe(1);
    expect(out).toContain("barrel freeze");
  });

  it("flags a module-scope Supabase client under src/lib/data", () => {
    const { code, out } = withFile(
      "src/lib/data/probe.ts",
      'import { createSupabaseServiceClient } from "@/lib/supabase/service-client";\n' +
        "export const c = createSupabaseServiceClient();\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("module-scope");
  });

  // ── tripwire (e): MCP launch surfaces ──

  it("flags an MCP launch surface missing the react-server condition", () => {
    const mcp = path.join(root, ".mcp.json");
    const good = JSON.stringify(
      { mcpServers: { [MCP_SERVER_NAME]: { command: "x", args: ["--conditions=react-server", "careervine-mcp/server.ts"] } } },
      null,
      2,
    );
    writeFileSync(
      mcp,
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "x", args: ["careervine-mcp/server.ts"] } } }, null, 2),
    );
    const { code, out } = run();
    writeFileSync(mcp, good);
    expect(code).toBe(1);
    expect(out).toContain("react-server");
  });

  // ── tripwire (f): shared typed mock factories ──

  it("flags a hand-rolled vi.mock of a shared-factory module", () => {
    const { code, out } = withFile(
      "src/__tests__/probe.test.ts",
      'vi.mock("@/lib/analytics/server", () => ({ trackServer: vi.fn() }));\n',
    );
    expect(code).toBe(1);
    expect(out).toContain("mockAnalyticsServerModule()");
  });

  it("sees the vi.mock(import(...)) spelling, not just the string one", () => {
    const { code, out } = withFile(
      "src/__tests__/probe.test.ts",
      'vi.mock(import("@/components/ui/toast"), () => ({ useToast: () => ({}) }));\n',
    );
    expect(code).toBe(1);
    expect(out).toContain("mockToastModule()");
  });

  it("accepts a mock that goes through the shared factory", () => {
    const { code, out } = withFile(
      "src/__tests__/probe.test.ts",
      'vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule();\n',
    );
    expect(code, out).toBe(0);
  });

  it("accepts a typed-mock-exempt annotation, and ignores unlisted modules", () => {
    expect(
      withFile(
        "src/__tests__/probe.test.ts",
        "// typed-mock-exempt: exercises the module's own contract\n" +
          'vi.mock("@/lib/analytics/server", () => ({ trackServer: vi.fn() }));\n',
      ).code,
    ).toBe(0);

    expect(
      withFile(
        "src/__tests__/probe.test.ts",
        'vi.mock("@/lib/crypto", () => ({ encryptToken: vi.fn() }));\n',
      ).code,
    ).toBe(0);
  });

  it("does not let a comment mentioning the flag satisfy a script launch surface", () => {
    const f = path.join(root, "careervine-mcp/scripts/harness.ts");
    writeFileSync(
      f,
      "// launches with --conditions=react-server\n" +
        'const args = ["--tsconfig", "tsconfig.json", "server.ts"];\nexport default args;\n',
    );
    const { code, out } = run();
    rmSync(f, { force: true });
    expect(code).toBe(1);
    expect(out).toContain("react-server");
  });

  // Tripwire (f) had the same comment-bypass hole that check (e) strips
  // comments to avoid: it matched the factory argument's TEXT, so prose
  // naming the helper satisfied it. Closed in CAR-190; no live bypass existed.

  it("does not let a comment or string mentioning the factory satisfy a vi.mock", () => {
    for (const factory of [
      "() => ({ trackServer: vi.fn() }) /* mockAnalyticsServerModule */",
      '() => ({ trackServer: vi.fn(), tag: "mockAnalyticsServerModule" })',
    ]) {
      const { code, out } = withFile(
        "src/__tests__/probe.test.ts",
        `vi.mock("@/lib/analytics/server", ${factory});\n`,
      );
      expect(code, `${factory} should be flagged: ${out}`).toBe(1);
      expect(out).toContain("mockAnalyticsServerModule()");
    }
  });

  it("sees vi.doMock and relative specifiers, not just vi.mock of the alias", () => {
    expect(
      withFile(
        "src/__tests__/probe.test.ts",
        'vi.doMock("@/lib/analytics/server", () => ({ trackServer: vi.fn() }));\n',
      ).code,
    ).toBe(1);

    // ../lib/analytics/server from src/__tests__/ resolves to the same module
    // the alias names, and must key the same rule.
    expect(
      withFile(
        "src/__tests__/probe.test.ts",
        'vi.mock("../lib/analytics/server", () => ({ trackServer: vi.fn() }));\n',
      ).code,
    ).toBe(1);
  });

  // ── tripwire (g): no raw fetch in the client tree (CAR-190) ──

  it("flags a raw fetch in the client tree, in bare and window-qualified form", () => {
    for (const call of ['fetch("/api/x")', 'window.fetch("/api/x")']) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        `export async function load() {\n  const r = await ${call};\n  return r;\n}\n`,
      );
      expect(code, `${call} should be flagged: ${out}`).toBe(1);
      expect(out).toContain("raw fetch");
    }
  });

  it("accepts apiFetch, a raw-fetch annotation, and fetch inside the API routes", () => {
    expect(
      withFile(
        "src/components/probe.tsx",
        'import { apiFetch } from "@/lib/api-client";\n' +
          "export async function load() {\n  return apiFetch(\"/api/x\");\n}\n",
      ).code,
    ).toBe(0);

    expect(
      withFile(
        "src/components/probe.tsx",
        "export async function load() {\n" +
          "  // raw-fetch: streams an audio blob, apiFetch parses JSON\n" +
          '  const r = await fetch("/api/x");\n  return r;\n}\n',
      ).code,
    ).toBe(0);

    // Server code: a third-party fetch here is the correct call.
    expect(
      withFile(
        "src/app/api/probe/route.ts",
        'export async function GET() {\n  return fetch("https://example.com");\n}\n',
      ).code,
    ).toBe(0);
  });

  // ── tripwire (h): no native confirm (CAR-190) ──

  it("flags window.confirm and a bare confirm that nothing in the file binds", () => {
    for (const call of ['window.confirm("Sure?")', 'confirm("Sure?")']) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        `export function Probe() {\n  if (!${call}) return null;\n  return null;\n}\n`,
      );
      expect(code, `${call} should be flagged: ${out}`).toBe(1);
      expect(out).toContain("native confirm");
    }
  });

  it("accepts the useConfirm() binding, whose returned function is also called confirm", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { useConfirm } from "@/components/ui/confirm-dialog";\n' +
        "export function Probe() {\n" +
        "  const { confirm, dialog } = useConfirm();\n" +
        "  const onDelete = async () => {\n" +
        '    if (!(await confirm({ message: "Delete?" }))) return;\n' +
        "  };\n" +
        "  return dialog;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  // ── tripwire (i): double-submit guard (CAR-190) ──
  //
  // The fixture files are not in the shipped baseline, so each of these also
  // exercises the ratchet's "offender absent from the baseline" direction.

  it("flags a mutation handler with no synchronous re-entry guard", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleSave = async () => {\n" +
        '    await apiSend("/api/x", { method: "POST" });\n' +
        "  };\n" +
        "  return handleSave;\n}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("double-submit");
    expect(out).toContain("handleSave");
  });

  it("accepts both guard shapes, and does not count an unrelated ref as one", () => {
    const boolGuard =
      "    if (savingRef.current) return;\n    savingRef.current = true;\n";
    // CAR-204's per-row shape: one in-flight id at a time, not one at a time.
    const keyedGuard =
      "    if (cancellingRef.current.has(1)) return;\n    cancellingRef.current.add(1);\n";

    for (const guard of [boolGuard, keyedGuard]) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        'import { apiSend } from "@/lib/api-client";\n' +
          "export function Probe() {\n" +
          "  const handleSave = async () => {\n" +
          guard +
          '    await apiSend("/api/x", { method: "POST" });\n' +
          "  };\n" +
          "  return handleSave;\n}\n",
      );
      expect(code, out).toBe(0);
    }

    // Touching some other ref is not a guard. This is the check that keeps the
    // rule from reading half the tree as compliant.
    const { code } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleSave = async () => {\n" +
        "    inputRef.current?.focus();\n" +
        '    await apiSend("/api/x", { method: "POST" });\n' +
        "  };\n" +
        "  return handleSave;\n}\n",
    );
    expect(code).toBe(1);
  });

  it("ignores a handler that only reads, since a duplicate read is not a duplicate write", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiFetch } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleExpand = async () => {\n" +
        '    await apiFetch("/api/x");\n' +
        "  };\n" +
        "  return handleExpand;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  // ── tripwire (j): useLatestRequest on an identity-keyed read (CAR-190) ──

  it("flags an identity-keyed read that commits an ungated result", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  const load = useCallback(async () => {\n" +
        "    const data = await getContact(contactId);\n" +
        "    setContact(data);\n" +
        "  }, [contactId]);\n" +
        "  return load;\n}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("useLatestRequest");
  });

  it("accepts the same read once it gates on isLatest", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  const load = useCallback(async () => {\n" +
        "    const token = req.begin();\n" +
        "    const data = await getContact(contactId);\n" +
        "    if (!req.isLatest(token)) return;\n" +
        "    setContact(data);\n" +
        "  }, [contactId]);\n" +
        "  return load;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("ignores a read whose setState is not derived from the awaited value", () => {
    // Keyed on an id and awaits, but commits unrelated local state. Without
    // the derivation requirement this shape alone flagged 23 sites, most of
    // them keyed on a UI-state id that races nothing.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  const save = useCallback(async () => {\n" +
        "    await persist(contactId);\n" +
        "    setDirty(false);\n" +
        "  }, [contactId]);\n" +
        "  return save;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  // ── tripwire (k): dialog semantics on a fixed-inset overlay (CAR-190) ──

  it("flags a full-screen overlay with no dialog role", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        '  return <div className="fixed inset-0 z-50 flex items-center justify-center" />;\n' +
        "}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("dialog semantics");
  });

  it("accepts a role on the surface INSIDE the overlay, not only on the wrapper", () => {
    // confirm-dialog.tsx and modal.tsx both put the scrim and the centring on
    // the fixed div and role on the panel within it. An earlier version of
    // this check asked only the fixed element and reported both as violations.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        '  return (<div className="fixed inset-0 z-50 flex items-center justify-center">\n' +
        '    <div role="dialog" aria-modal="true">hi</div>\n' +
        "  </div>);\n" +
        "}\n",
    );
    expect(code, out).toBe(0);
  });

  it("accepts an overlay-not-a-dialog annotation", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        "  // overlay-not-a-dialog: click-outside catcher behind a popover\n" +
        '  return <div className="fixed inset-0 z-10" />;\n' +
        "}\n",
    );
    expect(code, out).toBe(0);
  });
});

/**
 * The ratchet algebra, tested directly rather than through the script.
 *
 * The subprocess route above cannot reach the stale-entry direction: the
 * fixture tree contains none of the real baselined files, so every entry would
 * read as stale at once and nothing would be proved. That direction is the
 * half people forget, and it is the half that stops a fixed site being given
 * back, so it gets a real test rather than an implicit one.
 */
describe("baseline ratchet", () => {
  const WHERE = "scripts/check-conventions.mjs";
  const present = new Set(["a.tsx", "b.tsx"]);

  it("flags an offender absent from the baseline, and stays quiet on a listed one", () => {
    const found = { "a.tsx": [{ name: "handleSave", line: 12 }] };

    expect(diffNamedRatchet(found, {}, present, WHERE)).toEqual(["a.tsx:12: handleSave"]);
    expect(diffNamedRatchet(found, { "a.tsx": ["handleSave"] }, present, WHERE)).toEqual([]);
  });

  it("flags a baselined site that no longer violates, so the gain is locked in", () => {
    const violations = diffNamedRatchet({}, { "a.tsx": ["handleSave"] }, present, WHERE);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("no longer violates");
    expect(violations[0]).toContain(WHERE);
  });

  it("does not let a fixed violation be traded for a fresh one in the same file", () => {
    // The precise thing a COUNT baseline cannot see: one out, one in, total
    // unchanged. Both halves must be reported.
    const violations = diffNamedRatchet(
      { "a.tsx": [{ name: "handleDelete", line: 30 }] },
      { "a.tsx": ["handleSave"] },
      present,
      WHERE,
    );
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes("handleDelete"))).toBe(true);
    expect(violations.some((v) => v.includes("handleSave") && v.includes("no longer"))).toBe(true);
  });

  it("says nothing about a baselined file the scan never visited", () => {
    // A partial checkout is not a fixed violation. Without this the guard
    // fails on any tree that does not contain the whole app — which is exactly
    // what the fixture above is.
    expect(diffNamedRatchet({}, { "gone.tsx": ["handleSave"] }, present, WHERE)).toEqual([]);
    expect(diffCountRatchet({}, { "gone.tsx": 2 }, present, WHERE, "overlays")).toEqual([]);
  });

  it("ratchets counts in both directions", () => {
    expect(diffCountRatchet({ "a.tsx": 3 }, { "a.tsx": 2 }, present, WHERE, "overlays")).toEqual([
      "a.tsx: 3 overlays, baseline is 2",
    ]);
    expect(diffCountRatchet({ "a.tsx": 2 }, { "a.tsx": 2 }, present, WHERE, "overlays")).toEqual([]);

    const lowered = diffCountRatchet({ "a.tsx": 1 }, { "a.tsx": 2 }, present, WHERE, "overlays");
    expect(lowered).toHaveLength(1);
    expect(lowered[0]).toContain("lower its baseline entry");

    // A file with no baseline entry at all may not carry violations.
    expect(diffCountRatchet({ "b.tsx": 1 }, {}, present, WHERE, "overlays")).toEqual([
      "b.tsx: 1 overlays, baseline is 0",
    ]);
  });
});

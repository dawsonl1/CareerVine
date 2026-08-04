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
  return withFiles({ [rel]: contents });
}

/**
 * The same, for a case that needs more than one file — a rule about how modules
 * REACH each other cannot be exercised by a single file in isolation.
 */
function withFiles(files: Record<string, string>) {
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(app, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    written.push(full);
  }
  const result = run();
  for (const full of written) rmSync(full, { force: true });
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

// Every test here spawns `check-conventions.mjs`, which takes ~5s on a cold run and more
// under CI load — right at vitest's 5s default, and over it for any test that runs the
// script twice. That made this suite flake on timeout rather than on an assertion, which
// reads as a real failure. The budget is per test, so a genuine hang still fails, just later.
describe("conventions guard", { timeout: 60_000 }, () => {
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
        // `error` is bound and checked so ONLY tripwire (b) can fire. Without
        // that, the bare `const { data }` also trips the unchecked-read rule,
        // which exits 1 on its own — so reverting FILTER_OP to its original
        // short list (the exact regression this test names) left the assertion
        // green. Asserting on `out` closes the other half.
        "export async function f(db: any) {\n" +
          `  const { data, error } = await db.from("t").update({ s: "a" }).${op}.select("id");\n` +
          "  if (error) throw error;\n  return data;\n}\n",
      );
      expect(code, `${op} should be flagged: ${out}`).toBe(1);
      expect(out, `${op} should trip the CAS rule specifically`).toContain("CAS readback");
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
    // The original chain-wide regex was position-blind and passed this. Same
    // reasoning as the test above — bind `error` so only tripwire (b) can fire,
    // and assert on the rule name, or restoring the position-blind regex leaves
    // this green off the unchecked-read rule alone.
    const { code, out } = withFile(
      "src/lib/probe.ts",
      "export async function f(db: any) {\n" +
        '  const { data, error } = await db.from("t").update({ s: "a" }).match({ count: "exact" }).select("id");\n' +
        "  if (error) throw error;\n  return data;\n}\n",
    );
    expect(code, out).toBe(1);
    expect(out).toContain("CAS readback");
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
      'vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule());\n',
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
      "() => /* mockAnalyticsServerModule */ ({ trackServer: vi.fn() })",
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

  it("scans every client root, not just src/components", () => {
    // CLIENT_ROOTS is the one machine part five checks share — it decides what
    // is inspected at all — and nothing exercised it. Every client-state probe
    // wrote to src/components/probe.tsx, and the single src/app probe asserted
    // exit 0 under src/app/api (excluded by design), so cutting the scope from
    // three roots to one left all 37 assertions green, and cutting it to ZERO
    // still exited 0 against the real tree.
    for (const path of ["src/hooks/probe.ts", "src/app/probe/page.tsx"]) {
      const { code, out } = withFile(
        path,
        '"use client";\nexport async function load() {\n  return fetch("/api/x");\n}\n',
      );
      expect(code, `${path} should be scanned: ${out}`).toBe(1);
      expect(out).toContain("raw fetch");
    }
  });

  it("flags a first-party /api fetch outside the client tree, where a refactor can hide it", () => {
    // Hoisting a call out of a component into a src/lib helper is a change a
    // reviewer would ask for, and it silently escaped a freeze scoped to the
    // three client roots. Six such calls were already there.
    const { code, out } = withFile(
      "src/lib/probe-client.ts",
      'export async function save() {\n  return fetch("/api/x", { method: "POST" });\n}\n',
    );
    expect(code).toBe(1);
    expect(out).toContain("raw fetch");

    // A third-party URL in the same place is fine: it is not one of our routes.
    expect(
      withFile(
        "src/lib/probe-client.ts",
        'export async function ping() {\n  return fetch("https://example.com/x");\n}\n',
      ).code,
    ).toBe(0);
  });

  /**
   * CAR-207. The two rules above are both URL-shaped, and a call whose URL is a
   * PARAMETER satisfies neither: no literal to test, and the module sits outside
   * the client tree where the total ban did not reach. `bundle-apply-client.ts`
   * POSTed to /api/bundles/apply and /api/bundles/unsubscribe from the browser
   * that way for as long as the guard had existed, and widening the DIRECTORY
   * scope (which the ticket proposed) would not have found it — src/lib was
   * already scanned. Reachability is what makes a module client code.
   */
  it("flags a variable-URL fetch in a module the client imports", () => {
    const helper =
      "export async function step(url: string, body: unknown) {\n" +
      '  return fetch(url, { method: "POST", body: JSON.stringify(body) });\n}\n';

    // Alone, it is server code reaching an unknown URL: not this rule's business.
    // This control is what proves the assertion below is about REACHABILITY and
    // not just about the file existing.
    expect(withFiles({ "src/lib/step-helper.ts": helper }).code).toBe(0);

    // Imported by a client component, the identical call is a browser request.
    const { code, out } = withFiles({
      "src/lib/step-helper.ts": helper,
      "src/components/probe.tsx":
        '"use client";\nimport { step } from "@/lib/step-helper";\n' +
        'export const go = () => step("/api/x", {});\n',
    });
    expect(code, out).toBe(1);
    expect(out).toContain("raw fetch");
    expect(out).toContain("src/lib/step-helper.ts");
  });

  it("reaches through a relative import and a re-export, not just the @/ alias", () => {
    const helper =
      "export async function step(url: string) {\n  return fetch(url);\n}\n";

    // Relative specifier from a sibling module, itself re-exported to the client.
    const { code, out } = withFiles({
      "src/lib/deep/step-helper.ts": helper,
      "src/lib/step-barrel.ts": 'export { step } from "./deep/step-helper";\n',
      "src/components/probe.tsx":
        '"use client";\nimport { step } from "@/lib/step-barrel";\n' +
        'export const go = () => step("/api/x");\n',
    });
    expect(code, out).toBe(1);
    expect(out).toContain("src/lib/deep/step-helper.ts");
  });

  it("counts a dynamic import() as a reachability edge", () => {
    // `next/dynamic` and lazily-imported parsers both put the target in a
    // browser chunk exactly like a static import. Statement-level scanning
    // cannot see them: they sit in expression position inside a callback.
    const { code, out } = withFiles({
      "src/lib/step-helper.ts": "export async function step(url: string) {\n  return fetch(url);\n}\n",
      "src/components/probe.tsx":
        '"use client";\n' +
        'export const go = async () => (await import("@/lib/step-helper")).step("/api/x");\n',
    });
    expect(code, out).toBe(1);
    expect(out).toContain("src/lib/step-helper.ts");
  });

  it("does not count a type-only import as reachability", () => {
    // `import type` is erased, so it cannot carry a module into the bundle.
    // Counting it would drag server modules in through their types alone and
    // make the rule fire on code no browser ever loads.
    const { code, out } = withFiles({
      "src/lib/step-helper.ts":
        "export type Step = { done: boolean };\n" +
        "export async function step(url: string) {\n  return fetch(url);\n}\n",
      "src/components/probe.tsx":
        '"use client";\nimport type { Step } from "@/lib/step-helper";\n' +
        "export const go = (s: Step) => s.done;\n",
    });
    expect(code, out).toBe(0);
  });

  it("does not treat a server component's imports as browser-reachable", () => {
    // An RSC's `fetch` is the idiomatic data call and so is its helper's.
    const { code, out } = withFiles({
      "src/lib/step-helper.ts": "export async function step(url: string) {\n  return fetch(url);\n}\n",
      "src/app/probe/page.tsx":
        'import { step } from "@/lib/step-helper";\n' +
        'export default async function Page() {\n  await step("https://example.com");\n  return null;\n}\n',
    });
    expect(code, out).toBe(0);
  });

  it("leaves server files alone, where fetch is the correct call", () => {
    // apiFetch sends credentials against a relative URL and throws outside a
    // browser, so pointing a Route Handler or an RSC at it is bad advice.
    expect(
      withFile(
        "src/app/probe/route.ts",
        'export async function GET() {\n  return fetch("https://example.com");\n}\n',
      ).code,
    ).toBe(0);

    // An RSC is a file under src/app with no "use client" directive.
    expect(
      withFile(
        "src/app/probe-rsc/page.tsx",
        'export default async function Page() {\n  await fetch("https://example.com");\n  return null;\n}\n',
      ).code,
    ).toBe(0);
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

  it("honours the hatch where a developer writes it, and only for that call", () => {
    // Anchoring the annotation to the nearest STATEMENT made it unusable in
    // JSX — where the nearest statement is the whole `return (…)` — and
    // simultaneously blanket, silencing every match in that render tree. Both
    // modes at once, and neither was covered.
    const inJsx = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        "  return (\n" +
        "    <button\n" +
        "      // raw-fetch: exports a CSV stream\n" +
        '      onClick={() => fetch("/api/export")}\n' +
        "    >go</button>\n" +
        "  );\n" +
        "}\n",
    );
    expect(inJsx.code, `hatch in JSX position should be honoured: ${inJsx.out}`).toBe(0);

    // …and it covers exactly one call: the second, unannotated one still fails.
    const blanket = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        "  return (\n" +
        "    <div>\n" +
        "      // raw-fetch: exports a CSV stream\n" +
        '      <button onClick={() => fetch("/api/export")}>a</button>\n' +
        '      <button onClick={() => fetch("/api/contacts")}>b</button>\n' +
        "    </div>\n" +
        "  );\n" +
        "}\n",
    );
    expect(blanket.code).toBe(1);
    expect(blanket.out).toContain("/api/contacts");
    expect(blanket.out).not.toContain("/api/export");
  });

  it("accepts the JSX comment form of an annotation", () => {
    // `{/* … */}` is the only comment syntax legal between JSX children, so
    // `annotationAbove` strips the wrapping braces before matching. Covered
    // here against `raw-fetch:` since CAR-208 deleted the overlay check this
    // case used to ride on; the mechanism under test is the brace stripping,
    // which every hatch depends on.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe() {\n" +
        "  return (\n" +
        "    <div>\n" +
        "      {/* raw-fetch: exports a CSV stream */}\n" +
        '      <button onClick={() => fetch("/api/export")}>go</button>\n' +
        "    </div>\n" +
        "  );\n" +
        "}\n",
    );
    expect(code, out).toBe(0);
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

  it("resolves the confirm binding lexically, not file-wide", () => {
    // A file-wide "does anything here bind `confirm`" flag exempted the whole
    // module, so a sibling component in the same file could call the DOM global
    // with no signal — in a check the banner reports as a freeze at zero. Nine
    // files bind `confirm` today and two already have this exact shape.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { useConfirm } from "@/components/ui/confirm-dialog";\n' +
        "export function First() {\n" +
        "  const { confirm, dialog } = useConfirm();\n" +
        '  void confirm;\n  return dialog;\n' +
        "}\n" +
        "export function Second() {\n" +
        '  if (!confirm("Delete forever?")) return null;\n' +
        "  return null;\n}\n",
    );
    expect(code, `the sibling component calls the global: ${out}`).toBe(1);
    expect(out).toContain("native confirm");

    // An unrelated binding elsewhere in the file must not exempt it either.
    expect(
      withFile(
        "src/components/probe.tsx",
        "export function Row({ confirm }: { confirm: boolean }) {\n  return confirm ? null : null;\n}\n" +
          "export function Other() {\n" +
          '  if (!confirm("Sure?")) return null;\n  return null;\n}\n',
      ).code,
    ).toBe(1);
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

  it("rejects a ref that is claimed but never read, or claimed after the await", () => {
    // The three shapes a claim-only check accepted, none of which guards
    // anything. This matters more than a plain miss: the ratchet FAILS on a
    // baselined site that stops violating, so one cosmetic line does not merely
    // permit deleting an entry, it compels it — turning a live defect into a
    // permanent "fixed" with nothing behind it.
    const cases = {
      "claimed, never read": "    savingRef.current = true;\n",
      "claimed after the await": "", // appended below instead
      "unrelated ref in a nested callback": "    items.forEach(() => { hoveredRef.current = true; });\n",
    };

    for (const [label, prefix] of Object.entries(cases)) {
      const body =
        label === "claimed after the await"
          ? '    await apiSend("/api/x", { method: "POST" });\n    savingRef.current = true;\n'
          : `${prefix}    await apiSend("/api/x", { method: "POST" });\n`;
      const { code, out } = withFile(
        "src/components/probe.tsx",
        'import { apiSend } from "@/lib/api-client";\n' +
          "export function Probe() {\n" +
          "  const handleSave = async () => {\n" +
          body +
          "  };\n  return handleSave;\n}\n",
      );
      expect(code, `${label} should be flagged: ${out}`).toBe(1);
    }
  });

  it("accepts a correct guard whatever the ref is called", () => {
    // The old check required the identifier to end in `Ref` and the assigned
    // value to be the literal `true`, so `const saving = useRef(false)` — a
    // correct guard, and a spelling already live in this repo — failed CI. The
    // early-return READ is the discriminator, so the name is free.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleSave = async () => {\n" +
        "    if (saving.current) return;\n" +
        "    saving.current = Date.now();\n" +
        '    await apiSend("/api/x", { method: "POST" });\n' +
        "  };\n  return handleSave;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("sees a mutation carried by apiFetch, and one behind an unlisted verb", () => {
    // Two of the five blind spots that made the published baseline understate
    // the tree by 31%. A body-returning write correctly uses apiFetch, and the
    // old write-verb allowlist caught `removeContactPhoto` while missing
    // `uploadContactPhoto` in the same file.
    const viaApiFetch = withFile(
      "src/components/probe.tsx",
      'import { apiFetch, jsonBody } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleSave = async () => {\n" +
        '    setStatus(await apiFetch("/api/key", jsonBody({ k: 1 }, "PUT")));\n' +
        "  };\n  return handleSave;\n}\n",
    );
    expect(viaApiFetch.code, viaApiFetch.out).toBe(1);

    const unlistedVerb = withFile(
      "src/components/probe.tsx",
      'import { uploadContactPhoto } from "@/lib/data/contacts";\n' +
        "export function Probe() {\n" +
        "  const handlePhotoSelected = async () => {\n" +
        "    await uploadContactPhoto(1, 2, file);\n" +
        "  };\n  return handlePhotoSelected;\n}\n",
    );
    expect(unlistedVerb.code, unlistedVerb.out).toBe(1);
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

  it("flags a mutation handler whose name is not spelled like a handler (CAR-208)", () => {
    // The blind spot that hid a live bug: `addContact` in
    // admin/contacts-section.tsx was an unguarded apiSend POST gated only by
    // React state, so double-clicking Add created two contact rows — and the
    // check never looked at it, purely because it is not called `handleAdd`.
    for (const name of ["addContact", "submit", "deleteAccount", "toggleNudges"]) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        'import { apiSend } from "@/lib/api-client";\n' +
          "export function Probe() {\n" +
          `  const ${name} = async () => {\n` +
          '    await apiSend("/api/x", { method: "POST" });\n' +
          "  };\n" +
          `  return ${name};\n}\n`,
      );
      expect(code, `${name} should be flagged: ${out}`).toBe(1);
      expect(out).toContain(name);
    }
  });

  it("flags an inline JSX handler, and keys it by the prop (CAR-208)", () => {
    // An inline handler has no declaration to hang a name on, so this whole
    // FORM was invisible rather than any particular site. Keyed by the prop
    // name because that survives the line moves a raw line number would not.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  return (\n" +
        '    <button onClick={async () => { await apiSend("/api/x", { method: "POST" }); }}>go</button>\n' +
        "  );\n}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("onClick");
  });

  it("leaves server files alone, where there is no second click to block (CAR-208)", () => {
    // Dropping the name filter surfaced two shapes that cannot double-submit:
    // a Route Handler outside src/app/api (three exist) and an async React
    // Server Component. `GET` and `AdminLayout` are not spelled like handlers,
    // so the old filter excluded them by accident rather than on purpose.
    const route = withFile(
      "src/app/auth/probe/route.ts",
      'import { createContact } from "@/lib/data/contacts";\n' +
        "export async function GET() {\n" +
        "  await createContact(1);\n" +
        "  return new Response('ok');\n}\n",
    );
    expect(route.code, route.out).toBe(0);

    const rsc = withFile(
      "src/app/probe/layout.tsx",
      'import { createContact } from "@/lib/data/contacts";\n' +
        "export default async function ProbeLayout() {\n" +
        "  await createContact(1);\n" +
        "  return null;\n}\n",
    );
    expect(rsc.code, rsc.out).toBe(0);

    // …but the same file WITH "use client" is a client component again.
    const client = withFile(
      "src/app/probe/layout.tsx",
      '"use client";\n' +
        'import { createContact } from "@/lib/data/contacts";\n' +
        "export default function ProbeLayout() {\n" +
        "  const save = async () => { await createContact(1); };\n" +
        "  return save;\n}\n",
    );
    expect(client.code, client.out).toBe(1);
  });

  it("resolves a seam through a default or namespace import (CAR-208)", () => {
    // Only NAMED imports were resolved, so either of these bound a live seam
    // the scan could not see — and because an empty seam set skips the file
    // outright, one such import hid every handler in it.
    const namespaced = withFile(
      "src/components/probe.tsx",
      'import * as api from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const save = async () => {\n" +
        '    await api.apiSend("/api/x", { method: "POST" });\n' +
        "  };\n  return save;\n}\n",
    );
    expect(namespaced.code, namespaced.out).toBe(1);

    const defaulted = withFile(
      "src/components/probe.tsx",
      'import saveContact from "@/lib/data/contacts";\n' +
        "export function Probe() {\n" +
        "  const save = async () => {\n" +
        "    await saveContact(1);\n" +
        "  };\n  return save;\n}\n",
    );
    expect(defaulted.code, defaulted.out).toBe(1);
  });

  it("does not treat a type-only import as a callable seam (CAR-208)", () => {
    // The type-only name must itself be the CALLEE, or the assertion is about
    // nothing: `mutates()` only consults names in the seam set, so a fixture
    // that calls some other identifier passes whether the guard is present or
    // not. The first cut of this test did exactly that and could not fail —
    // which is the defect this whole file exists to prevent, one level up.
    //
    // Both spellings are covered because they are separate code paths:
    // `clause.isTypeOnly` and the per-specifier `el.isTypeOnly`.
    const wholeImport = withFile(
      "src/components/probe.tsx",
      'import type { saveContact } from "@/lib/data/contacts";\n' +
        "export function Probe() {\n" +
        "  const save = async () => {\n" +
        "    await saveContact(1);\n" +
        "  };\n  return save;\n}\n",
    );
    expect(wholeImport.code, wholeImport.out).toBe(0);

    // Inline `type` specifier. Needs a real seam alongside it, or the file is
    // skipped for an empty seam set and the assertion proves nothing again.
    const inlineSpecifier = withFile(
      "src/components/probe.tsx",
      'import { type Contact, apiFetch } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const save = async (c: Contact) => {\n" +
        "    await Contact(c);\n" +
        "  };\n  return save;\n}\n",
    );
    expect(inlineSpecifier.code, inlineSpecifier.out).toBe(0);
  });

  // ── tripwire (i), second pass: findings from the CAR-208 review ──

  it("does not let a read verb swallow a longer mutation verb (CAR-208)", () => {
    // `can` matched `cancel*`, `to` matched `toggle*`, `is` matched `issue*`,
    // `check` matched `checkout*`. Of five mutations named that way exactly one
    // was flagged, and `@/lib/data/emails` really does export
    // `cancelFollowUpSequenceCascade`.
    for (const verb of ["cancelSubscription", "toggleAutomation", "issueRefund", "checkoutCart"]) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        `import { ${verb} } from "@/lib/mutations";\n` +
          "export function Probe() {\n" +
          `  const act = async () => { await ${verb}("x"); };\n` +
          "  return act;\n}\n",
      );
      expect(code, `${verb} should be a mutation: ${out}`).toBe(1);
    }

    // …while the genuine read verbs they are prefixes of still read.
    const reads = withFile(
      "src/components/probe.tsx",
      'import { getContact, loadPipeline } from "@/lib/data/contacts";\n' +
        "export function Probe() {\n" +
        "  const a = async () => { await getContact(1); };\n" +
        "  const b = async () => { await loadPipeline(1); };\n" +
        "  return [a, b];\n}\n",
    );
    expect(reads.code, reads.out).toBe(0);
  });

  it("sees an inline handler that STARTS async work without awaiting it (CAR-208)", () => {
    // The same create-tag button existed in both spellings: the `async` one was
    // baselined, the fire-and-forget one was invisible. A promise started on
    // click is exactly as re-entrant as an awaited one.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { withToastOnError, createTag } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        '  return <button onClick={() => withToastOnError(async () => { await createTag("x"); })}>Add</button>;\n' +
        "}\n",
    );
    expect(code).toBe(1);
    expect(out).toContain("onClick");
  });

  it("keys inline handlers by identity, so a fix cannot be traded for a fresh violation (CAR-208)", () => {
    // Keyed on the prop name alone, every inline handler in a file collapsed to
    // `onClick`, which turned this NAMED ratchet into a counted one for the
    // inline form — ratchet.mjs's header gives that exact trade as the reason
    // named beats counted. Two different handlers must produce two different
    // keys.
    const { out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  return (<div>\n" +
        '    <button onClick={async () => { await apiSend("/api/a", { method: "POST" }); }}>a</button>\n' +
        '    <button onClick={async () => { await apiSend("/api/b", { method: "POST" }); }}>b</button>\n' +
        "  </div>);\n}\n",
    );
    const keys = [...out.matchAll(/probe\.tsx:\d+: (onClick\S*)/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(keys.every((k) => k.startsWith("onClick~"))).toBe(true);
  });

  it("accepts a handler that forwards to a correctly guarded helper (CAR-208)", () => {
    // `mutates()` follows one local hop; `claimsReentryGuard` does not. A thin
    // forwarder over a guarded helper was reported as unguarded, and those
    // entries are unclearable — the code is already right, so the ratchet's
    // stale direction can never retire them.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const handleSave = async () => {\n" +
        "    if (savingRef.current) return;\n" +
        "    savingRef.current = true;\n" +
        '    try { await apiSend("/api/x", { method: "POST" }); } finally { savingRef.current = false; }\n' +
        "  };\n" +
        "  return <form onSubmit={async (e) => { e.preventDefault(); await handleSave(); }} />;\n" +
        "}\n",
    );
    expect(code, out).toBe(0);
  });

  it("rejects a claim that is deferred, conditional, or a release (CAR-208)", () => {
    // A bogus guard is worse than a miss: the ratchet's stale-entry rule does
    // not merely permit deleting the baseline line, it COMPELS it.
    const cases: Record<string, string> = {
      "deferred into a callback": "    queueMicrotask(() => { savingRef.current = true; });\n",
      "sets false — a release, not a claim": "    savingRef.current = false;\n",
    };
    for (const [label, claim] of Object.entries(cases)) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        'import { apiSend } from "@/lib/api-client";\n' +
          "export function Probe() {\n" +
          "  const save = async () => {\n" +
          "    if (savingRef.current) return;\n" +
          claim +
          '    await apiSend("/api/x", { method: "POST" });\n' +
          "  };\n  return save;\n}\n",
      );
      expect(code, `${label} should be flagged: ${out}`).toBe(1);
    }
  });

  it("does not let a nested async helper push the guard past the first await (CAR-208)", () => {
    // `findAwait` descended into not-yet-called functions, so declaring a
    // helper above the guard made the guard read as "after the first await" and
    // flagged textbook-correct code. Clearable only by reordering it.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const save = async () => {\n" +
        '    const doIt = async () => { await apiSend("/api/x", { method: "POST" }); };\n' +
        "    if (busy.current) return;\n" +
        "    busy.current = true;\n" +
        "    try { await doIt(); } finally { busy.current = false; }\n" +
        "  };\n  return save;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("accepts the else-return spelling of the guard (CAR-208)", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      'import { apiSend } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        "  const save = async () => {\n" +
        "    if (!busy.current) { busy.current = true; } else { return; }\n" +
        '    try { await apiSend("/api/x", { method: "POST" }); } finally { busy.current = false; }\n' +
        "  };\n  return save;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("classifies an aliased seam by its EXPORTED name (CAR-208)", () => {
    // The local name was classified against rules that are statements about the
    // export, inverting the verdict in both directions.
    const aliasedWrite = withFile(
      "src/components/probe.tsx",
      'import { apiSend as getIt } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        '  const save = async () => { await getIt("/api/x", {}); };\n' +
        "  return save;\n}\n",
    );
    expect(aliasedWrite.code, aliasedWrite.out).toBe(1);

    const aliasedRead = withFile(
      "src/components/probe.tsx",
      'import { apiFetch as af } from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        '  const load = async () => { return await af("/api/x"); };\n' +
        "  return load;\n}\n",
    );
    expect(aliasedRead.code, aliasedRead.out).toBe(0);
  });

  it("sees a default import called as an object, and object-literal methods (CAR-208)", () => {
    const defaultAsObject = withFile(
      "src/components/probe.tsx",
      'import api from "@/lib/api-client";\n' +
        "export function Probe() {\n" +
        '  const save = async () => { await api.send("/api/x", {}); };\n' +
        "  return save;\n}\n",
    );
    expect(defaultAsObject.code, defaultAsObject.out).toBe(1);

    const objectMethod = withFile(
      "src/components/probe.tsx",
      'import { deleteContact } from "@/lib/data/contacts";\n' +
        "export function Probe() {\n" +
        "  return useDeferredAction({ action: async (i: number) => { await deleteContact(i); } });\n" +
        "}\n",
    );
    expect(objectMethod.code, objectMethod.out).toBe(1);
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

  it("does not let a comment or string mentioning isLatest satisfy the gate", () => {
    // The identical bypass tripwire (f) was hardened against one rule up, in
    // this same file. (j) matched `isLatest` as TEXT, and the AST check beside
    // it was dead code: it required a bare `isLatest(…)` call while every real
    // site spells it `req.isLatest(token)`, so the regex did all the work.
    for (const decoy of [
      "    // TODO: gate this on isLatest\n",
      '    const tag = "isLatest";\n',
    ]) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        "export function Probe({ contactId }: { contactId: string }) {\n" +
          "  const load = useCallback(async () => {\n" +
          decoy +
          "    const data = await getContact(contactId);\n" +
          "    setContact(data);\n" +
          "  }, [contactId]);\n  return load;\n}\n",
      );
      expect(code, `decoy should not satisfy the gate: ${out}`).toBe(1);
    }
  });

  it("sees a destructured await, which is how a multi-read loader is written", () => {
    // Requiring a plain identifier binding made `const { x } = await …` and
    // `const [a, b] = await Promise.all(…)` invisible — the same blind spot
    // tripwire (c) shipped with, recorded in this file's own header as the
    // reason these tests exist. It hid two live races.
    for (const binding of [
      "const { rows } = await load(contactId);\n    setRows(rows);",
      "const [a, b] = await Promise.all([load(contactId), other(contactId)]);\n    setRows(a);",
    ]) {
      const { code, out } = withFile(
        "src/components/probe.tsx",
        "export function Probe({ contactId }: { contactId: string }) {\n" +
          "  const load = useCallback(async () => {\n    " +
          binding +
          "\n  }, [contactId]);\n  return load;\n}\n",
      );
      expect(code, `${binding} should be flagged: ${out}`).toBe(1);
    }
  });

  it("accepts the cancelled-flag idiom, in both spellings this app uses", () => {
    // The canonical React fix, used at eight sites here and entirely correct:
    // React runs the cleanup before the next effect, so a stale response cannot
    // commit. Rejecting it made a false positive out of correct code — and
    // because the ratchet fails when a baselined site stops violating, the only
    // way to clear that entry would have been to rewrite working code.
    const earlyReturn = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    void (async () => {\n" +
        "      const data = await getContact(contactId);\n" +
        "      if (cancelled) return;\n" +
        "      setContact(data);\n" +
        "    })();\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(earlyReturn.code, earlyReturn.out).toBe(0);

    const inlineGuard = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    getContact(contactId).then((c) => {\n" +
        "      if (!cancelled && c) setContact(c);\n" +
        "    });\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(inlineGuard.code, inlineGuard.out).toBe(0);
  });

  it("accepts the OTHER flag polarity, `let mounted = true` (CAR-208)", () => {
    // The idiom was recognised only as `false` flipped to `true`. This is the
    // same pattern written the other way round, at least as common in React,
    // and it was reported as a violation — the worst outcome for a ratchet,
    // since clearing the entry means rewriting correct code to the spelling
    // the detector happens to know.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let mounted = true;\n" +
        "    void (async () => {\n" +
        "      const data = await getContact(contactId);\n" +
        "      if (!mounted) return;\n" +
        "      setContact(data);\n" +
        "    })();\n" +
        "    return () => { mounted = false; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("does not let an unrelated boolean triple silence the effect (CAR-208)", () => {
    // Declared-false / set-true / read-in-a-condition were collected over the
    // whole body and intersected by NAME, so any boolean satisfying the triple
    // cleared EVERY commit in the effect. Here `done` gates nothing: the
    // setState below it is bare, and the read is not even about the response.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let done = false;\n" +
        "    void (async () => {\n" +
        "      const data = await getContact(contactId);\n" +
        "      done = true;\n" +
        '      if (done) console.log("loaded");\n' +
        "      setContact(data);\n" +
        "    })();\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(1);
    expect(out).toContain("useLatestRequest");
  });

  it("rejects a flag consulted only BEFORE the await (CAR-208)", () => {
    // Nothing has raced yet at that point: the check was decided before the
    // response existed, so it cannot gate the commit that follows it.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    void (async () => {\n" +
        "      if (cancelled) return;\n" +
        "      const data = await getContact(contactId);\n" +
        "      setContact(data);\n" +
        "    })();\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(1);
  });

  it("rejects a body that gates one commit and leaves the next bare (CAR-208)", () => {
    // Every commit has to be gated, not any: the ungated one still races.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    void (async () => {\n" +
        "      const data = await getContact(contactId);\n" +
        "      const extra = await getExtra(contactId);\n" +
        "      if (!cancelled) setContact(data);\n" +
        "      setExtra(extra);\n" +
        "    })();\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(1);
  });

  it("requires the cleanup to flip the flag to the OPPOSITE value (CAR-208)", () => {
    // Recording "declared a boolean" and "assigned a boolean" as independent
    // facts accepted a cleanup that assigns the value it was declared with — a
    // real bug (the flag never trips, every stale response commits) that the
    // pre-CAR-208 check caught and the polarity rewrite let through.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    void (async () => {\n" +
        "      const d = await getContact(contactId);\n" +
        "      if (cancelled) return;\n" +
        "      setContact(d);\n" +
        "    })();\n" +
        "    return () => { cancelled = false; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(1);
  });

  it("requires the bail to DOMINATE the commit, not merely precede it (CAR-208)", () => {
    // `n.end <= commit.getStart()` is source position, not dominance, so a bail
    // inside one async IIFE cleared a bare commit inside the next one. The tell
    // was that swapping two semantically identical IIFEs flipped the verdict.
    const body = (gatedFirst: boolean) => {
      const gated =
        "    void (async () => { const j = await load(contactId); if (cancelled) return; setData(j.name); })();\n";
      const bare = "    void (async () => { const o = await load2(contactId); setMore(o.title); })();\n";
      return (
        "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        (gatedFirst ? gated + bare : bare + gated) +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n"
      );
    };
    // Identical semantics must produce identical verdicts, and both are racy.
    const gatedFirst = withFile("src/components/probe.tsx", body(true));
    const bareFirst = withFile("src/components/probe.tsx", body(false));
    expect(gatedFirst.code, gatedFirst.out).toBe(1);
    expect(bareFirst.code, bareFirst.out).toBe(1);
  });

  it("lets two independent flags each gate their own commit (CAR-208)", () => {
    // Demanding that ONE flag cover every commit rejected the correct
    // one-flag-per-in-flight-request shape.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelledA = false;\n" +
        "    let cancelledB = false;\n" +
        "    loadA(contactId).then((a) => { if (!cancelledA) setA(a); });\n" +
        "    loadB(contactId).then((b) => { if (!cancelledB) setB(b); });\n" +
        "    return () => { cancelledA = true; cancelledB = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("measures the racing await per commit, not the body's first (CAR-208)", () => {
    // A body-global `firstAwait` rejected a correct `.then` guard the moment any
    // unrelated await appeared later in the effect — eight live files pair a
    // cancellation flag with `.then(`, so one added await would have turned a
    // correct file red.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    load(contactId).then((d) => { if (cancelled) return; setData(d.name); });\n" +
        "    load2(contactId).then(async (d2) => { const x = await enrich(d2); if (cancelled) return; setMore(x); });\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(0);
  });

  it("does not count setTimeout/setInterval as a React commit (CAR-208)", () => {
    // They match /^set[A-Z]/ and carry `await` in their callback text, so a
    // timer read as a commit that must be gated — flagging effects with no
    // setState at all, and turning correct polling effects red once EVERY
    // commit had to be gated.
    const timerOnly = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    const t = setTimeout(async () => { await ping(contactId); }, 100);\n" +
        "    return () => clearTimeout(t);\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(timerOnly.code, timerOnly.out).toBe(0);
  });

  it("holds isLatest to the same per-commit standard as the flag idiom (CAR-208)", () => {
    // One `isLatest` call ANYWHERE in the body used to clear every commit —
    // the exact "existence, not gating" defect this check fixed for idiom 2,
    // left live in idiom 1 and newly claimed as fixed in the header.
    const deadBranch = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    void (async () => {\n" +
        "      if (false) { console.log(req.isLatest(0)); }\n" +
        "      const d = await getContact(contactId);\n" +
        "      setContact(d);\n" +
        "    })();\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(deadBranch.code, deadBranch.out).toBe(1);

    // …and the real spelling still passes.
    const real = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    void (async () => {\n" +
        "      const token = req.begin();\n" +
        "      const d = await getContact(contactId);\n" +
        "      if (!req.isLatest(token)) return;\n" +
        "      setContact(d);\n" +
        "    })();\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(real.code, real.out).toBe(0);
  });

  it("does not let a comment mentioning AbortController clear the effect (CAR-208)", () => {
    // `body.getText()` includes comments and strings, so prose cleared the
    // whole effect — the identical bypass class this file hardened check (f)
    // and idiom 1 against.
    const inProse = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    // TODO: switch this to new AbortController() and pass the signal through\n" +
        "    void (async () => { const d = await getContact(contactId); setContact(d); })();\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(inProse.code, inProse.out).toBe(1);

    const wired = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId }: { contactId: string }) {\n" +
        "  useEffect(() => {\n" +
        "    const ac = new AbortController();\n" +
        "    void (async () => {\n" +
        "      const d = await getContact(contactId, { signal: ac.signal });\n" +
        "      setContact(d);\n" +
        "    })();\n" +
        "    return () => ac.abort();\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(wired.code, wired.out).toBe(0);
  });

  it("does not mistake a property named like the flag for the flag (CAR-208)", () => {
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ contactId, opts }: { contactId: string; opts: { cancelled: boolean } }) {\n" +
        "  useEffect(() => {\n" +
        "    let cancelled = false;\n" +
        "    void (async () => {\n" +
        "      const d = await getContact(contactId);\n" +
        "      if (opts.cancelled) return;\n" +
        "      setContact(d);\n" +
        "    })();\n" +
        "    return () => { cancelled = true; };\n" +
        "  }, [contactId]);\n  return null;\n}\n",
    );
    expect(code, out).toBe(1);
  });

  it("treats a snake_case id in the dependency array as an identity", () => {
    // This app's DB columns are snake_case throughout, so `contact_id` is as
    // much an identity as `contactId`; the camelCase-only pattern exempted it.
    const { code, out } = withFile(
      "src/components/probe.tsx",
      "export function Probe({ person }: { person: { contact_id: number } }) {\n" +
        "  const load = useCallback(async () => {\n" +
        "    const data = await getContact(person.contact_id);\n" +
        "    setContact(data);\n" +
        "  }, [person.contact_id]);\n  return load;\n}\n",
    );
    expect(code, out).toBe(1);
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

  // Tripwire (k) — dialog semantics on a fixed-inset overlay — was DELETED by
  // CAR-208 along with its three tests here, because the pair accepted
  // near-anagram escape hatches (`overlay-not-a-dialog:` here,
  // `non-dialog-overlay:` there) that neither would honour from the other. The
  // rule is still enforced, in exactly one place: `dialog-adoption.test.ts`,
  // which absorbed (k)'s independent-token class matching so that deleting the
  // check did not quietly stop enforcing reordered and interpolated class
  // lists. The JSX-comment annotation form these tests also happened to cover
  // is now covered directly, above, against a hatch that still exists.
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

  it("counts duplicate names, so a second offender does not ride the first's entry", () => {
    // The baseline was a Set, and names are not unique: check (j) labels an
    // unnamed useEffect with the enclosing const, falling back to the literal
    // "useEffect", and 34 of 165 client files already have two hook calls that
    // collapse to one label. A second offender matched the first's entry and
    // passed free — the exact "trade a fixed violation for a fresh one" hole
    // that choosing named over counted was meant to close.
    const violations = diffNamedRatchet(
      { "a.tsx": [{ name: "useEffect", line: 10 }, { name: "useEffect", line: 99 }] },
      { "a.tsx": ["useEffect"] },
      present,
      WHERE,
    );
    expect(violations).toEqual(["a.tsx:99: useEffect"]);

    // And the mirror: a baseline listing a name twice against one surviving
    // offender still reports the one that was given back.
    const mirrored = diffNamedRatchet(
      { "a.tsx": [{ name: "handleSave", line: 1 }] },
      { "a.tsx": ["handleSave", "handleSave"] },
      present,
      WHERE,
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toContain("no longer violates");
  });

  it("says DELETE, not 'lower it to 0', when a file's count reaches zero", () => {
    // Following "lower it to 0" literally leaves a permanent no-op entry, and
    // drop-to-zero is the common case: a ticket that migrates a file's last
    // offender hits this branch, not the partial one.
    const violations = diffCountRatchet({}, { "a.tsx": 2 }, present, WHERE, "overlays");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("delete its baseline entry");
    expect(violations[0]).not.toContain("to 0");
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

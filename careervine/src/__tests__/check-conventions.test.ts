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
});

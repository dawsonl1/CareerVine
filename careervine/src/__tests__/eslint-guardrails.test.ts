/**
 * CAR-151: the eslint.config.mjs guardrails are load-bearing security fences,
 * so they get the same regression coverage as the code they protect.
 *
 * Both fences failed silently before this suite existed: the MCP raw-client
 * pattern list matched `../lib/db` but not `./lib/db` (ESLint 9 matches these
 * with the `ignore` package, not minimatch), and nothing at all fenced the web
 * direction of the db() seam. A silent guardrail is worse than none, so these
 * assert on real ESLint output rather than on the config object's shape.
 *
 * Lints synthetic text against the project's actual config, keyed by file path
 * — so the assertions cover the files/ignores globs too, not just the rules.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, it, expect, beforeAll } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: projectRoot });
});

/** Rule ids reported when `text` is linted as if it lived at `filePath`. */
async function ruleIdsFor(filePath: string, text: string): Promise<string[]> {
  const [result] = await eslint.lintText(text, {
    filePath: path.join(projectRoot, filePath),
    warnIgnored: false,
  });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "<fatal>");
}

const importsRawDb = (specifier: string) =>
  `import { db } from "${specifier}";\nexport const a = db;\n`;

describe("eslint guardrails: MCP must not take the raw client (CAR-151)", () => {
  // Every relative depth a file under src/mcp can use to reach lib/db. The
  // original pattern list covered only the second of these.
  it.each([
    ["src/mcp/probe.ts", "./lib/db"],
    ["src/mcp/tools/probe.ts", "../lib/db"],
    ["src/mcp/tools/nested/probe.ts", "../../lib/db"],
    ["src/mcp/tools/probe.ts", "@/mcp/lib/db"],
  ])("%s importing %s is restricted", async (filePath, specifier) => {
    expect(await ruleIdsFor(filePath, importsRawDb(specifier))).toContain(
      "no-restricted-imports",
    );
  });

  it("src/mcp/lib/db.ts itself may hold the raw client", async () => {
    expect(await ruleIdsFor("src/mcp/lib/db.ts", importsRawDb("./db"))).not.toContain(
      "no-restricted-imports",
    );
  });

  it("MCP may not acquire the service-role client outside lib/db.ts", async () => {
    const text = `import { createSupabaseServiceClient } from "@/lib/supabase/service-client";\nexport const a = createSupabaseServiceClient;\n`;
    expect(await ruleIdsFor("src/mcp/tools/probe.ts", text)).toContain(
      "no-restricted-imports",
    );
  });

  // The syntax rule bans calling db() at all, so binding the client to a
  // variable can't launder it past a `db().from(...)`-shaped selector.
  it.each([
    ["direct member call", `db().from("contacts");`],
    ["rpc surface", `db().rpc("f");`],
    ["storage surface", `db().storage.from("b");`],
    ["two-step binding", `const c = db();\nc.from("contacts");`],
  ])("%s is restricted in MCP tools", async (_label, body) => {
    const text = `declare function db(): any;\nexport function p() {\n  ${body}\n}\n`;
    expect(await ruleIdsFor("src/mcp/tools/probe.ts", text)).toContain(
      "no-restricted-syntax",
    );
  });
});

describe("eslint guardrails: src/app must not resolve the implicit db() seam (CAR-151)", () => {
  const imports = (specifier: string) =>
    `import { x } from "${specifier}";\nexport const a = x;\n`;

  it.each([
    "@/lib/queries",
    "@/lib/data/contacts",
    "@/lib/data/interactions",
    "@/lib/data/action-items",
    "@/lib/data/meetings",
    "@/lib/data/attachments",
    "@/lib/data/follow-ups",
    "@/lib/data/home",
    "@/lib/data/users",
  ])("a new API route importing %s is restricted", async (specifier) => {
    expect(await ruleIdsFor("src/app/api/probe/route.ts", imports(specifier))).toContain(
      "no-restricted-imports",
    );
  });

  // These two take an explicit client (or none), so the 7 email routes and
  // api/contacts/search keep working.
  it.each(["@/lib/data/emails", "@/lib/data/postgrest"])(
    "%s stays available to API routes",
    async (specifier) => {
      expect(
        await ruleIdsFor("src/app/api/probe/route.ts", imports(specifier)),
      ).not.toContain("no-restricted-imports");
    },
  );

  // Being grandfathered on the service-role client is not a licence to read
  // through the process-global db() slot as well.
  it("a service-client-grandfathered route is still fenced off the seam", async () => {
    expect(
      await ruleIdsFor("src/app/api/gmail/drafts/route.ts", imports("@/lib/data/contacts")),
    ).toContain("no-restricted-imports");
  });

  it("a grandfathered route keeps its service-client exemption", async () => {
    const text = `import { createSupabaseServiceClient } from "@/lib/supabase/service-client";\nexport const a = createSupabaseServiceClient;\n`;
    expect(await ruleIdsFor("src/app/api/gmail/drafts/route.ts", text)).not.toContain(
      "no-restricted-imports",
    );
  });

  // "use client" pages get their own module instance in the browser bundle, so
  // db() there is always the anon client.
  it("an allowlisted client page may import the barrel", async () => {
    expect(await ruleIdsFor("src/app/contacts/page.tsx", imports("@/lib/queries"))).not.toContain(
      "no-restricted-imports",
    );
  });

  it("a non-allowlisted src/app file may not", async () => {
    expect(await ruleIdsFor("src/app/settings/page.tsx", imports("@/lib/queries"))).toContain(
      "no-restricted-imports",
    );
  });
});

#!/usr/bin/env node
/**
 * CI guard (CAR-158): four data-layer conventions that tsc and eslint cannot
 * express, each of which has already cost a real incident or a real audit
 * finding.
 *
 *   (a) queries.ts stays a frozen re-export barrel, and no module under
 *       src/lib/data or src/lib/rules acquires a module-scope Supabase client.
 *   (b) the rule-17 CAS shape: a conditional .update() whose success is read
 *       back through .select() instead of a row count.
 *   (c) `const { data }` destructures that never bind `error`, in src/lib and
 *       the cron routes.
 *   (d) growth of raw query-builder use in the MCP data layer.
 *
 * Modelled on scripts/check-ui-events.mjs (same walk, same violation format,
 * same exit contract), but AST-based rather than line-based: (a) needs to know
 * a top-level statement's KIND, (b) needs to see a whole call chain, and (c)
 * needs to read a binding pattern. Line greps get all three wrong. Parsing
 * goes through the `typescript` compiler API, which is the only DECLARED
 * parser dependency — acorn/@babel/parser resolve today but only transitively
 * through eslint and next, so depending on them lets an unrelated bump break
 * CI.
 *
 * Run: node scripts/check-conventions.mjs   (npm run check:conventions)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const EXTENSIONS = [".ts", ".tsx"];

/** Files that are tests or type-tests: conventions here are exercised, not obeyed. */
const isTestFile = (rel) =>
  rel.includes("/__tests__/") || rel.includes(".test.") || rel.includes(".type-test.");

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory does not exist in this checkout
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const rel = (file) => file.split("\\").join("/");

function parse(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/**
 * Collapse a multi-line call chain onto one line so the violation names the
 * methods rather than whichever identifier happened to start the chain
 * (printing the first raw line yields a bare "service", which tells nobody
 * anything).
 */
function oneLine(text, max = 150) {
  const flat = text.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Text of the comments attached above a node, used for the opt-out annotations. */
function leadingComments(sf, node) {
  const ranges = ts.getLeadingCommentRanges(sf.getFullText(), node.getFullStart()) ?? [];
  return ranges.map((r) => sf.getFullText().slice(r.pos, r.end)).join("\n");
}

const failures = [];
/** @param {string} rule @param {string[]} violations @param {string} advice */
function report(rule, violations, advice) {
  if (violations.length > 0) failures.push({ rule, violations, advice });
}

// ── (a) barrel freeze + no module-scope Supabase client ──────────────────
//
// Both halves are regression freezes over an already-clean state: queries.ts
// is 100% re-exports today and there is no module-scope client anywhere in
// src. The guard exists so it stays that way — a module-scope client is what
// made the old queries.ts unusable from the server and the MCP (CAR-146).

const BARREL = "src/lib/queries.ts";
const CLIENT_FACTORY = /\b(createSupabase\w*Client|createBrowserClient|createServerClient|createClient)\s*\(/;

{
  const violations = [];
  const sf = parse(BARREL);
  for (const stmt of sf.statements) {
    // A re-export is `export { x } from "./y"` — an ExportDeclaration that
    // carries a module specifier. `export { x }` without one is a local
    // re-export of something declared here, which the freeze also forbids.
    const isReExport = ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined;
    if (!isReExport) {
      violations.push(`${BARREL}:${lineOf(sf, stmt)}: ${stmt.getText(sf).split("\n")[0].trim()}`);
    }
  }
  report(
    "queries.ts barrel freeze",
    violations,
    "src/lib/queries.ts is a frozen compatibility barrel (CAR-146): re-export\n" +
      "  statements only. Put new queries in a domain module under src/lib/data/\n" +
      "  and re-export them here.",
  );
}

{
  const violations = [];
  const files = [...walk("src/lib/data", []), ...walk("src/lib/rules", [])];
  for (const file of files) {
    const r = rel(file);
    if (isTestFile(r)) continue;
    const sf = parse(file);
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        // Only an initializer that CALLS a factory counts. The lazy seam
        // (`let browserClient: SupabaseClient | null = null`) declares a
        // module-scope variable and assigns it inside db(); that is the
        // sanctioned pattern and must not trip this rule.
        if (decl.initializer && CLIENT_FACTORY.test(decl.initializer.getText(sf))) {
          violations.push(`${r}:${lineOf(sf, stmt)}: ${stmt.getText(sf).split("\n")[0].trim()}`);
        }
      }
    }
  }
  report(
    "module-scope Supabase client",
    violations,
    "A client constructed at module scope binds the module to one runtime and\n" +
      "  breaks server/MCP reuse (CAR-146). Resolve it lazily via db() from\n" +
      "  src/lib/data/client.ts instead.",
  );
}

// ── (b) rule-17 CAS readback shape ───────────────────────────────────────
//
// Detection is SHAPE-ONLY on purpose, and that is a considered choice rather
// than a shortcut. Deciding whether a written column is re-tested by a filter
// needs dataflow: the payload is frequently a variable built one statement
// earlier, or a caller-supplied `Tables[..]["Update"]` in a generic helper.
// A written-column-overlap heuristic would catch the literal-payload cases
// and silently MISS the variable-payload ones, which is strictly worse than
// shape-only, because it reports green on a real violation.
//
// So: flag `.update(...)` + a filter + `.select()` without `count: "exact"`,
// and require an explicit annotation to stand down. The annotations are the
// point — each one records that a human checked the shape.

const CAS_OPT_OUT = /\/\/\s*cas-checked:/;

// The full PostgREST filter alphabet, not a sample of it. The original short
// list (eq|is|neq|in|gt|gte|lt|lte|match|filter) could not see a claim guarded
// by .contains() or .or(), both of which exist in this repo.
const FILTER_OP =
  /\.(eq|is|neq|in|gt|gte|lt|lte|match|filter|not|or|like|ilike|contains|containedBy|overlaps|textSearch|rangeGt|rangeGte|rangeLt|rangeLte|rangeAdjacent)\s*\(/;

/**
 * True when the `.update()` feeding this `.select()` passes a count option.
 *
 * Asked of the update call itself via the AST rather than by regexing the whole
 * chain text: a chain-wide match is position-blind, so `count` appearing
 * anywhere in the prefix (inside a filter argument, a nested call, an unrelated
 * object literal) would read as compliant even though the update declares none.
 * A non-literal second argument is treated as compliant, since its contents are
 * unknowable statically and flagging it would punish correct code.
 */
function updateDeclaresCount(selectNode) {
  let cur = selectNode.expression; // PropertyAccessExpression: <prefix>.select
  while (cur) {
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "update") {
        const opts = cur.arguments[1];
        if (!opts) return false;
        if (!ts.isObjectLiteralExpression(opts)) return true; // opaque, assume intentional
        return opts.properties.some((p) => {
          const n = p.name;
          return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === "count";
        });
      }
      cur = callee;
      continue;
    }
    return false;
  }
  return false;
}

{
  const violations = [];
  const files = [...walk("src/lib", []), ...walk("src/app", []), ...walk("src/mcp", [])];
  for (const file of files) {
    const r = rel(file);
    if (isTestFile(r)) continue;
    const sf = parse(file);

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "select") {
          const chain = node.getText(sf);
          // The chain prefix, which is everything left of this .select().
          if (/\.update\s*\(/.test(chain) && FILTER_OP.test(chain)) {
            const stmt = ts.findAncestor(node, ts.isStatement) ?? node;
            if (!updateDeclaresCount(node) && !CAS_OPT_OUT.test(leadingComments(sf, stmt))) {
              violations.push(`${r}:${lineOf(sf, node)}: ${oneLine(chain)}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  report(
    "rule-17 CAS readback",
    violations,
    "A conditional .update() must report success via a row COUNT, not a\n" +
      '  .select() readback: use .update(payload, { count: "exact" }) and check\n' +
      "  the count. If this chain is not a compare-and-set (the filtered columns\n" +
      "  are not the written ones), annotate it:  // cas-checked: <why>",
  );
}

// ── (c) unchecked `const { data }` reads ─────────────────────────────────
//
// Ships with NO baseline: CAR-158 resolved all ~101 pre-existing sites rather
// than freezing them, because a baseline would have left the debt in place
// behind a guard that merely LOOKED active.
//
// Auth and storage responses count. A failed `auth.admin.getUserById` is
// exactly as control-flow-bearing as a failed PostgREST read — silently
// becoming "no user" is precisely the failure mode this rule exists to stop.

const TOLERATED = /\/\/\s*error-tolerated:/;

/** Every ObjectBindingPattern reachable in a binding tree, at any nesting. */
function* objectPatterns(name) {
  if (ts.isObjectBindingPattern(name)) {
    yield name;
    for (const el of name.elements) {
      if (el.name && !ts.isIdentifier(el.name)) yield* objectPatterns(el.name);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el) && el.name && !ts.isIdentifier(el.name)) {
        yield* objectPatterns(el.name);
      }
    }
  }
}

{
  const violations = [];
  const files = [...walk("src/lib", []), ...walk("src/app/api/cron", [])];
  for (const file of files) {
    const r = rel(file);
    if (isTestFile(r)) continue;
    const sf = parse(file);

    for (const node of collect(sf)) {
      if (!ts.isVariableDeclaration(node)) continue;
      if (!node.name) continue;

      // `must(await q)` throws on error, so it needs no error binding.
      const init = node.initializer ? node.initializer.getText(sf) : "";
      if (/\bmust\s*\(/.test(init)) continue;
      // Only await-ed responses are Supabase/GoTrue results; a plain object
      // destructure is unrelated.
      if (!/\bawait\b/.test(init)) continue;

      const stmt = ts.findAncestor(node, ts.isStatement) ?? node;
      if (TOLERATED.test(leadingComments(sf, stmt))) continue;

      // Every object pattern in the binding tree, not just the top level.
      // `const [{ data: a }, { data: b }] = await Promise.all([...])` binds two
      // responses inside an ArrayBindingPattern, and the old top-level-only
      // check could never see either: the declaration's name is an
      // ArrayBindingPattern, and the inner patterns are BindingElements rather
      // than VariableDeclarations. That blind spot hid 9 live unchecked reads.
      for (const pattern of objectPatterns(node.name)) {
        const bound = pattern.elements.map((el) =>
          ts.isIdentifier(el.propertyName ?? el.name) ? (el.propertyName ?? el.name).getText(sf) : "",
        );
        if (!bound.includes("data")) continue;
        if (bound.includes("error")) continue;
        violations.push(`${r}:${lineOf(sf, node)}: ${oneLine(pattern.getText(sf), 110)}`);
      }
    }
  }
  report(
    "unchecked read",
    violations,
    "This read drops its `error`, so a failure is indistinguishable from an\n" +
      "  empty result. Either wrap it in must() from src/lib/data/client.ts (for\n" +
      "  reads whose result drives control flow), or bind and handle `error`. If\n" +
      "  empty-on-error genuinely IS the right product behaviour, say so:\n" +
      "    // error-tolerated: <specific reason>",
  );
}

/** Every node in a source file, flattened. */
function collect(sf) {
  const out = [];
  const visit = (n) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ── (d) raw query-builder growth in the MCP data layer ───────────────────
//
// A RATCHET, not a freeze at zero, and deliberately so. src/mcp/lib/db.ts
// still holds 45 `.from(` calls across 16 tables: MCP-specific projections,
// ownership assertions, and the calendar/companies surface that CAR-151 did
// not delegate to src/lib/data. Migrating them is that ticket's work, not a
// type-polish ticket's. What this guard buys is that the number can only go
// DOWN — a new raw builder fails CI, and removing one prompts lowering the
// baseline so the ground is never given back.

const MCP_DB = "src/mcp/lib/db.ts";
const MCP_DB_BASELINE = 45;

{
  const source = readFileSync(MCP_DB, "utf8");
  const count = (source.match(/\.from\s*\(/g) ?? []).length;

  if (count > MCP_DB_BASELINE) {
    report(
      "MCP raw query builders",
      [`${MCP_DB}: ${count} \`.from(\` calls, baseline is ${MCP_DB_BASELINE}`],
      "New MCP queries go through a domain module in src/lib/data/ so web and\n" +
        "  MCP share one implementation and one set of scoping guarantees\n" +
        "  (CAR-151). The existing 45 are grandfathered; do not add to them.",
    );
  } else if (count < MCP_DB_BASELINE) {
    console.log(
      `note: ${MCP_DB} is down to ${count} \`.from(\` calls (baseline ${MCP_DB_BASELINE}).\n` +
        `      Lower MCP_DB_BASELINE in scripts/check-conventions.mjs to ${count} to lock the gain in.`,
    );
  }
}

// ── (e) every MCP server launch carries --conditions=react-server ────────
//
// The MCP server's import graph reaches server-only-fenced modules under
// src/lib, and `server-only` THROWS unless resolved through React's server
// layer. tsx only applies that layer when given --conditions=react-server, so
// every way of launching careervine-mcp/server.ts needs the flag.
//
// This guard exists because the flag was originally added to ONE of three
// launch surfaces (npm start), leaving .mcp.json — the entry point Claude Code
// actually uses — and the e2e harness dead at startup. Nothing caught it: the
// mcp CI job runs `tsc --noEmit`, which never evaluates a module. A launch
// surface is exactly the kind of thing that gets added later and silently
// misses a flag, so it is asserted here rather than trusted to review.

const REACT_SERVER_FLAG = "--conditions=react-server";
const MCP_ENTRY = "careervine-mcp/server.ts";

/** Remove block and line comments so prose cannot satisfy a code check. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

{
  const violations = [];

  /** Every launch surface: [label, does it launch the MCP server, its full text]. */
  const surfaces = [];

  // .mcp.json — Claude Code's registration, args array per server.
  try {
    const raw = readFileSync("../.mcp.json", "utf8");
    const parsed = JSON.parse(raw);
    for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
      const args = Array.isArray(cfg?.args) ? cfg.args : [];
      const launchesMcp = args.some((a) => typeof a === "string" && a.endsWith("server.ts"));
      if (launchesMcp) surfaces.push([`.mcp.json (mcpServers.${name})`, args.join(" ")]);
    }
  } catch {
    // Absent or unparseable .mcp.json is not this guard's business.
  }

  // careervine-mcp/package.json — any script that runs server.ts.
  try {
    const parsed = JSON.parse(readFileSync("../careervine-mcp/package.json", "utf8"));
    for (const [name, cmd] of Object.entries(parsed.scripts ?? {})) {
      if (typeof cmd === "string" && cmd.includes("server.ts")) {
        surfaces.push([`careervine-mcp/package.json (scripts.${name})`, cmd]);
      }
    }
  } catch {
    // no-op
  }

  // careervine-mcp/scripts/*.ts — harnesses that spawn the server as a child.
  // Comments are stripped first: this very file documents the flag in prose
  // directly above the args array, and a plain text match would let that prose
  // satisfy the check after someone deleted the actual argument.
  for (const file of walk("../careervine-mcp/scripts", [])) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (code.includes("server.ts")) surfaces.push([rel(file), code]);
  }

  for (const [label, text] of surfaces) {
    if (!text.includes(REACT_SERVER_FLAG)) violations.push(`${label}: launches the MCP server without ${REACT_SERVER_FLAG}`);
  }

  report(
    "MCP launch missing react-server condition",
    violations,
    `Every launch of ${MCP_ENTRY} must pass ${REACT_SERVER_FLAG}. Without it,\n` +
      "  `server-only` resolves to its throwing entry point and the server dies during\n" +
      "  module evaluation — before any runtime guard can report why. The mcp CI job only\n" +
      "  typechecks, so this failure is otherwise invisible until someone tries to use it.",
  );
}

// ── Report ───────────────────────────────────────────────────────────────

if (failures.length > 0) {
  for (const { rule, violations, advice } of failures) {
    console.error(`\n✖ ${rule}: ${violations.length} violation(s)\n  ${advice}\n`);
    for (const v of violations) console.error("  " + v);
  }
  console.error("");
  process.exit(1);
}

// Scope is named rather than asserted globally: each rule covers a specific
// tree, and a bare "all clean" would overstate what was actually inspected.
console.log(
  "✓ conventions guard: queries.ts barrel frozen; no module-scope client in src/lib/{data,rules};\n" +
    "  CAS shape clean in src/{lib,app,mcp}; unchecked reads clean in src/lib + src/app/api/cron;\n" +
    `  ${MCP_DB} within its ${MCP_DB_BASELINE} baseline; MCP launches carry ${REACT_SERVER_FLAG}.`,
);

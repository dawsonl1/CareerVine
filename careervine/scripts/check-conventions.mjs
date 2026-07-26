#!/usr/bin/env node
/**
 * CI guard (CAR-158, CAR-187, CAR-190, CAR-208): conventions that tsc and
 * eslint cannot express, each of which has already cost a real incident or a
 * real audit finding.
 *
 * ELEVEN checks under ten labels — (a) reports twice, once per half. Keep this
 * list and the count in CONVENTIONS.md section d in step with the code; both
 * drifted to "four" while the file carried seven (CAR-190).
 *
 * ── What these checks are, and are not ──
 *
 * (a), (e), (f) and (g)/(h) are decidable: a statement either is a re-export or
 * is not, a launch surface either carries the flag or does not. The rest are
 * HEURISTICS over an AST with no type information, and a clean run from them is
 * evidence, not proof. Each one's header names its own blind spots; the pattern
 * across all of them is that they cannot see through a value (a class list in a
 * variable, a payload built one statement earlier, a callee behind an alias),
 * and that their verb-based judgements are lexical rather than semantic. Read
 * a green run as "nothing matched the shapes we know how to look for".
 *
 * The cost of forgetting that is on the record twice. Tripwire (c) shipped
 * blind to array destructuring with nine live violations inside its own scan
 * scope, and check (i) shipped with five blind spots that understated its
 * baseline by 31% — both reported clean the whole time.
 *
 *   Data layer (CAR-158)
 *   (a) queries.ts stays a frozen re-export barrel, and no module under
 *       src/lib/data or src/lib/rules acquires a module-scope Supabase client.
 *   (b) the rule-17 CAS shape: a conditional .update() whose success is read
 *       back through .select() instead of a row count.
 *   (c) `const { data }` destructures that never bind `error`, in src/lib and
 *       the cron routes.
 *   (d) growth of raw query-builder use in the MCP data layer.
 *
 *   Packaging / tests
 *   (e) every MCP server launch surface carries --conditions=react-server.
 *   (f) a vi.mock of a shared-factory module uses that factory (CAR-187).
 *
 *   Client state (CAR-190), over src/components + src/hooks + src/app minus
 *   the API routes:
 *   (g) no raw fetch(: reads go through apiFetch, mutations through apiSend.
 *   (h) no window.confirm / global confirm(: use useConfirm().
 *   (i) a mutation handler carries a synchronous useRef double-submit guard.
 *   (j) an identity-keyed async read gates its setState on useLatestRequest.
 *
 * There is no (k). It checked that a `fixed inset-0` overlay outside modal.tsx
 * carried role="dialog", and CAR-208 deleted it: its baseline was empty, and
 * `src/__tests__/dialog-adoption.test.ts` enforces the same rule over a broader
 * file set in a stricter form (it additionally fails on an overlay class its
 * scanner cannot attribute, which this check would silently skip). Two guards
 * for one rule was not merely redundant, it was a trap — they accepted
 * near-anagram escape hatches, `// overlay-not-a-dialog:` here and
 * `// non-dialog-overlay:` there, and neither accepted the other's. The first
 * contributor with a legitimate non-dialog overlay would have written whichever
 * token the error they hit first named, and stayed red against the other. The
 * hatch vocabulary is seven tokens now, not eight.
 *
 * (g) and (h) are freezes at zero: CAR-188 cleared the tree, so the first new
 * violation fails. (i) and (j) ship as RATCHETS over a named baseline, for the
 * reason check (d) documents at length — a live guard over an honest baseline
 * beats a clean guard that had to wait for a sweep. The ticket asked for a
 * "warning listing offenders"; a warning exits 0, which is what let CAR-154 and
 * CAR-158 decay to 6 and 1 files respectively, so these fail instead. See
 * BASELINES below for the contract in both directions.
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { diffNamedRatchet } from "./lib/ratchet.mjs";

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

/**
 * The run of comment lines immediately above `node`'s own line.
 *
 * Anchoring an annotation to `findAncestor(node, ts.isStatement)` — which the
 * data-layer checks do, correctly, because their nodes ARE statement-shaped —
 * fails badly for a node in JSX or expression position, in both directions at
 * once. A `fetch` inside `onClick={() => …}` has the whole `return (…)` as its
 * nearest statement, so a comment written directly above the call attaches to
 * nothing and the hatch is unusable; and a comment that DOES attach up there
 * suppresses every match in the entire render tree, so one reason silences an
 * unrelated violation three elements away.
 *
 * Reading the physical lines above the node fixes both: the annotation lands
 * where a developer writes it, and it covers exactly one node. Block and JSX
 * comment forms count too, since `{/* … *\/}` is the only comment syntax legal
 * between JSX children.
 */
function annotationAbove(sf, node) {
  const text = sf.getFullText();
  const lines = text.split("\n");
  const nodeLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;

  const collected = [];
  for (let i = nodeLine - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^\{/, "").replace(/\}$/, "").trim();
    if (line === "") continue; // a blank line does not break the run
    if (/^(\/\/|\/\*|\*)/.test(line)) {
      collected.push(line);
      continue;
    }
    break;
  }
  return collected.join("\n");
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

// ── (f) shared typed mock factories ──────────────────────────────────────
//
// The suite makes ~340 vi.mock calls, and `vi.mock(path, factory)` does not
// typecheck the factory against the module it replaces — so a fake keeps
// compiling after the real export is renamed, gains an argument, or is joined
// by a new one the fake never provides. CAR-187 put shared, module-typed
// factories behind the eight most-mocked modules (151 sites); this check is
// what stops the 152nd from hand-rolling an untyped object again.
//
// Deliberately the INVERSE scope of every other rule here — and with no file
// filter at all, rather than the isTestFile() one the others invert. Only a
// test calls vi.mock, so the filter would buy nothing but a blind spot: it
// excludes `.itest.ts`, and the integration tier having no vi.mock today is a
// property of today, not a rule.
//
// Matching is on a real CallExpression to the required factory, not on the
// factory argument's TEXT containing its name (CAR-190). The text form let a
// comment or a string mentioning `mockToastModule` satisfy the check, exactly
// the bypass check (e) strips comments to prevent one rule over. No live
// bypass existed — this is a latent hole closed while the file was open.

const TYPED_MOCK_OPT_OUT = /\/\/\s*typed-mock-exempt:/;

/** module specifier → the shared factory its mocks must go through. */
const SHARED_MOCK_FACTORIES = {
  "@/lib/supabase/service-client": "mockServiceClientModule",
  "@/lib/supabase/server-client": "mockServerClientModule",
  "@/lib/supabase/browser-client": "mockBrowserClientModule",
  "@/lib/supabase/config": "mockSupabaseConfigModule",
  "@/components/auth-provider": "mockAuthProviderModule",
  "@/components/ui/toast": "mockToastModule",
  "@/lib/analytics/server": "mockAnalyticsServerModule",
  "@/lib/analytics/client": "mockAnalyticsClientModule",
};

/**
 * Normalise a module specifier to its `@/…` spelling.
 *
 * A relative specifier reaches the same module and must key the same rule; the
 * old text match saw only the alias form, so `../lib/supabase/service-client`
 * was silently unguarded. There are zero relative mocks of these modules today,
 * which is a property of today rather than a rule.
 */
function normaliseSpecifier(spec, fromFile) {
  if (!spec.startsWith(".")) return spec;
  const dir = fromFile.split("/").slice(0, -1).join("/");
  const parts = [];
  for (const seg of `${dir}/${spec}`.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const path = parts.join("/");
  return path.startsWith("src/") ? `@/${path.slice("src/".length)}` : path;
}

/**
 * The mocked module specifier, for both spellings vitest accepts:
 * `vi.mock("@/lib/x", …)` and `vi.mock(import("@/lib/x"), …)`.
 */
function mockedSpecifier(node) {
  const arg = node.arguments[0];
  if (!arg) return null;
  if (ts.isStringLiteral(arg)) return arg.text;
  if (
    ts.isCallExpression(arg) &&
    arg.expression.kind === ts.SyntaxKind.ImportKeyword &&
    arg.arguments[0] &&
    ts.isStringLiteral(arg.arguments[0])
  ) {
    return arg.arguments[0].text;
  }
  return null;
}

/** True when `node`'s subtree actually CALLS `name`, rather than mentioning it. */
function callsIdentifier(node, name) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

{
  const violations = [];
  for (const file of walk("src", [])) {
    const r = rel(file);
    const sf = parse(file);

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        // vi.doMock is vi.mock without the hoist; same drift, same rule.
        (node.expression.name.text === "mock" || node.expression.name.text === "doMock") &&
        node.expression.expression.getText(sf) === "vi" &&
        node.arguments.length >= 2
      ) {
        const raw = mockedSpecifier(node);
        const spec = raw === null ? null : normaliseSpecifier(raw, r);
        const required = spec && SHARED_MOCK_FACTORIES[spec];
        if (required && !callsIdentifier(node.arguments[1], required)) {
          const stmt = ts.findAncestor(node, ts.isStatement) ?? node;
          if (!TYPED_MOCK_OPT_OUT.test(leadingComments(sf, stmt))) {
            violations.push(`${r}:${lineOf(sf, node)}: mocks ${spec} without ${required}()`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  report(
    "untyped mock of a shared-factory module",
    violations,
    "A hand-rolled factory is not typechecked against the module it replaces,\n" +
      "  so it keeps compiling after the real export changes (CAR-187). Use the\n" +
      "  shared factory from src/__tests__/helpers/ — it returns the module's full\n" +
      "  type and takes your stub or overrides. If this mock genuinely cannot go\n" +
      "  through it, say why:  // typed-mock-exempt: <reason>",
  );
}

// ── Client-state guards (CAR-190): shared scope and ratchet machinery ────
//
// One scope for all five: the client tree. src/app/api is server code, where
// fetch to a third party is the correct call and there is no DOM to confirm
// in; tests exercise these conventions rather than obeying them.

const CLIENT_ROOTS = ["src/components", "src/hooks", "src/app"];

/**
 * Every client-tree source file, as a repo-relative path.
 *
 * Walked once and shared: five checks and the ratchets' existence test all
 * want the same list, and re-walking three trees per consumer is the kind of
 * thing that makes a CI guard feel slow enough to be worth skipping.
 */
const CLIENT_FILES = (() => {
  const out = [];
  for (const root of CLIENT_ROOTS) {
    for (const file of walk(root, [])) {
      const r = rel(file);
      if (r.startsWith("src/app/api/") || isTestFile(r)) continue;
      out.push(r);
    }
  }
  return out.sort();
})();

// Named rather than counted (which is what check (d) does) because a count
// lets a fixed violation be traded for a fresh one with the total unchanged,
// and the whole point of these guards is that new code cannot regress. The
// algebra, and the argument for a ratchet over the ticket's proposed warning,
// live in scripts/lib/ratchet.mjs.

const BASELINE_HOME = "scripts/check-conventions.mjs";

/** The client files this run actually scanned; the ratchets' existence check. */
const CLIENT_FILE_SET = new Set(CLIENT_FILES);

/** Group [{file, name, line}] into the shape diffNamedRatchet() wants. */
function byFile(rows) {
  const out = {};
  for (const { file, name, line } of rows) (out[file] ??= []).push({ name, line });
  return out;
}

/**
 * Baseline entries whose file is gone.
 *
 * The ratchets skip their stale-entry check for a file the scan never visited,
 * which is right for a partial checkout but conflates "not scanned" with
 * "deleted". Left alone, a deleted or renamed path keeps its entry forever:
 * the printed totals overstate the real debt, and recreating a file at that
 * path silently pre-authorises whatever the dead entry lists.
 *
 * The two cases are separated by asking whether this baseline recognises the
 * tree AT ALL. If not one of its files is on disk we are not looking at the
 * checkout it describes (a fixture, a partial clone), and it has nothing to
 * say. Once even one is present, an absent sibling is genuinely gone. That
 * beats a file-count threshold, which would be a magic number, and beats
 * per-directory existence, which a fixture can satisfy by accident.
 */
function deadBaselinePaths(baseline) {
  const paths = Object.keys(baseline).sort();
  if (!paths.some((f) => existsSync(f))) return [];
  return paths
    .filter((f) => !existsSync(f))
    .map((f) => `${f}: no longer exists — delete its baseline entry in ${BASELINE_HOME}`);
}

/**
 * True for a file that runs on the server: a Route Handler, or a component
 * under src/app with no `"use client"` directive.
 *
 * Checks (g) and (h) must skip these. `src/app/api/` is not the whole server
 * surface — three Route Handlers live outside it, and so do nine React Server
 * Components including an `async` admin layout. In a server component,
 * `fetch()` IS the idiomatic data fetch, and the advice (g) prints points at
 * `apiFetch`, which sends `credentials: "same-origin"` against a relative URL
 * and throws `Failed to parse URL` outside a browser. Flagging them would send
 * the first person to write ordinary Next.js data fetching to a helper that
 * cannot work there.
 */
function isServerFile(sf, r) {
  if (/\/route\.tsx?$/.test(r)) return true;
  if (!r.startsWith("src/app/")) return false;
  const first = sf.statements[0];
  const hasUseClient =
    first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client";
  return !hasUseClient;
}

/** A `fetch()` whose URL literal is one of our own API routes. */
function fetchesFirstPartyApi(call, sf) {
  const arg = call.arguments[0];
  if (!arg) return false;
  if (ts.isStringLiteral(arg)) return arg.text.startsWith("/api/");
  if (ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return /^`?\/api\//.test(arg.getText(sf).replace(/^`/, "`"));
  }
  return false;
}

// ── (g) no raw fetch( in the client tree ─────────────────────────────────
//
// Reads go through apiFetch, status-only mutations through apiSend, so a
// non-2xx throws ApiRequestError instead of an error body being read as the
// success shape. CAR-188 migrated all 111 sites; this freezes the result at
// zero. The hatch exists for the genuinely non-API-route call — a streamed
// response, a third-party endpoint, a blob download — and demands a reason.

const RAW_FETCH_OPT_OUT = /(?:\/\/|\/\*|\*)\s*raw-fetch:/;

// Where the rule applies, and why it is two scopes rather than one:
//
//   - the CLIENT TREE bans every raw fetch, first-party or not, because client
//     code has no business hand-rolling a request at all;
//   - EVERYWHERE ELSE under src/, a fetch at a literal `/api/...` URL is still
//     a violation, because a relative URL only resolves in a browser. That
//     second scope exists because the first one is trivially escaped by an
//     ordinary refactor: hoisting a call out of a component into a `src/lib`
//     helper is a change a reviewer would ASK for, and it silently left the
//     freeze. Six such calls were already sitting there, two of them
//     hand-rolling the exact `!res.ok → parse → throw` dance apiFetch exists to
//     delete.
//
// src/lib/api-client.ts is the sanctioned wrapper and is exempt by definition.
const API_CLIENT = "src/lib/api-client.ts";

{
  const violations = [];
  const clientTree = new Set(CLIENT_FILES);
  const everywhere = [...new Set([...CLIENT_FILES, ...walk("src", []).map(rel)])]
    .filter((r) => !isTestFile(r) && !r.startsWith("src/app/api/") && r !== API_CLIENT)
    .sort();

  for (const file of everywhere) {
    const sf = parse(file);
    if (isServerFile(sf, file)) continue;
    const inClientTree = clientTree.has(file);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isBare = ts.isIdentifier(callee) && callee.text === "fetch";
        const isGlobal =
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fetch" &&
          /^(window|globalThis|global|self)$/.test(callee.expression.getText(sf));
        if ((isBare || isGlobal) && (inClientTree || fetchesFirstPartyApi(node, sf))) {
          if (!RAW_FETCH_OPT_OUT.test(annotationAbove(sf, node))) {
            violations.push(`${file}:${lineOf(sf, node)}: ${oneLine(node.getText(sf), 100)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  report(
    "raw fetch in the client tree",
    violations,
    "Client code reaches our routes through src/lib/api-client.ts: apiFetch for\n" +
      "  reads (typed off the route, so an error body cannot typecheck as success),\n" +
      "  apiSend for status-only mutations. An interactive handler wraps that in\n" +
      "  withToastOnError and gates its state update on the `true` return. If this\n" +
      "  call genuinely is not one of our API routes, say why:\n" +
      "    // raw-fetch: <specific reason>",
  );
}

// ── (h) no window.confirm / global confirm( ──────────────────────────────
//
// Irreversible actions get the confirm modal from
// src/components/ui/confirm-dialog.tsx, not the native dialog. No escape
// hatch, by the ticket: there is no case for the browser's own dialog here.
//
// The subtlety is that useConfirm() returns a function CALLED `confirm`, so a
// bare `confirm(...)` is the house pattern at twelve sites and the global at
// none. The two are separated by BINDING — and the binding has to be resolved
// LEXICALLY, from the call site outward.
//
// A file-wide "does anything here declare `confirm`" flag was the first
// version, and it turned nine files blind: one `const { confirm } = useConfirm()`
// in one component exempted the whole module, so a sibling component in the
// same file could call the DOM global and get no signal. Two files already have
// the multi-component shape that makes that live, and a plain `const confirm =
// …` or even a loop variable named `confirm` had the same effect. That is a
// hole in a check the success banner reports as a freeze at zero.

/** True when some enclosing scope of `node` declares the name `confirm`. */
function confirmIsBoundAt(node) {
  const declaresConfirm = (scope) => {
    let found = false;
    const walk = (n, depth) => {
      if (found) return;
      // Do not descend into a nested function: its own declarations belong to
      // its scope, not to this one.
      if (depth > 0 && isFunctionLike(n)) {
        // …except for its parameters, which ARE this node's ancestors' concern
        // only when that function is on the path, handled by the outer loop.
        return;
      }
      const name = n.name;
      if (
        name &&
        ts.isIdentifier(name) &&
        name.text === "confirm" &&
        (ts.isVariableDeclaration(n) ||
          ts.isBindingElement(n) ||
          ts.isParameter(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isImportSpecifier(n) ||
          ts.isImportClause(n))
      ) {
        found = true;
        return;
      }
      ts.forEachChild(n, (c) => walk(c, depth + 1));
    };
    walk(scope, 0);
    return found;
  };

  for (let scope = node.parent; scope; scope = scope.parent) {
    if (isFunctionLike(scope) || ts.isBlock(scope) || ts.isSourceFile(scope)) {
      if (declaresConfirm(scope)) return true;
    }
  }
  return false;
}

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

{
  const violations = [];
  for (const file of CLIENT_FILES) {
    const sf = parse(file);
    if (isServerFile(sf, file)) continue;

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isGlobal =
          ts.isPropertyAccessExpression(callee) && 
          callee.name.text === "confirm" &&
          /^(window|globalThis|global|self)$/.test(callee.expression.getText(sf));
        const isBareGlobal =
          ts.isIdentifier(callee) && callee.text === "confirm" && !confirmIsBoundAt(node);
        if (isGlobal || isBareGlobal) {
          violations.push(`${file}:${lineOf(sf, node)}: ${oneLine(node.getText(sf), 100)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  report(
    "native confirm dialog",
    violations,
    "An irreversible action gets the app's confirm modal, not the browser's:\n" +
      "  `const { confirm, dialog } = useConfirm()` from\n" +
      "  src/components/ui/confirm-dialog.tsx, awaited as\n" +
      "  `if (!(await confirm({ … }))) return;`, with `{dialog}` rendered. The\n" +
      "  native dialog is unstyled, blocks the main thread, and is suppressible\n" +
      "  by the browser.",
  );
}

// ── (i) synchronous double-submit guard on a mutation handler ────────────
//
// The rule is a useRef(false) read and set BEFORE the first await, not a
// boolean state flag: `disabled={saving}` cannot block the second of two
// clicks in one tick, because the state update has not rendered yet. It
// cannot block a keyboard path at all — the today-schedule popover fired one
// POST per Enter keydown against a create-event route with no idempotency
// key, so key repeat produced a row of duplicate Google Calendar events and
// Meet links (CAR-190).
//
// A candidate is any async function in a CLIENT file that awaits a MUTATING
// seam — apiSend, withToastOnError, or a @/lib import whose name does not open
// with a read verb. Three forms count: a function declaration, a variable
// initialised to a function (through useCallback/useMemo), and an inline
// `onX={async () => …}` JSX handler. Requiring the mutation drops reads, where
// a second call is wasteful rather than harmful.
//
// WHAT THIS CANNOT SEE. It is a heuristic, and a clean run is not a proof:
//
//   * a mutation reached through TWO local hops — one is followed, the second
//     is not, so `handleX → a() → b() → apiSend()` reads as inert;
//   * a seam behind a value rather than a name: a callee held in a variable, a
//     method on an imported object, a dynamic `import()`;
//   * a handler passed as a prop and invoked in another file, where neither
//     half looks like a mutation on its own;
//   * whether a candidate is reachable from a user GESTURE at all. It cannot
//     be, without a call graph, which is why the baseline holds effect-driven
//     loaders and background pollers alongside real submit handlers.
//
// It over-reports in the other direction too, deliberately — see the READ_VERB
// note below and the baseline's own docblock.

// Every `@/lib` module, not a hand-listed five. The narrow list silently
// exempted whole categories: `@/lib/pipeline-queries` (PDF upload/delete),
// `@/lib/gmail-sync-client` (writes email rows), `@/lib/onboarding/…`. Those
// are not edge cases — one of them, `handleUnsubscribe`, POSTs a destructive
// contact-removal loop with no synchronous guard at all.
const SEAM_MODULE = /^@\/lib\//;

// A DENYLIST of read verbs, not an allowlist of write verbs. The allowlist
// was the wrong default: a new mutation verb was invisible until someone
// remembered to add it, and the misses were arbitrary rather than principled —
// `handlePhotoRemove` was caught and `handlePhotoSelected`, same file, same
// state flag, same upload write, was not, purely because "remove" was listed
// and "upload" was not. Inverting makes the safe direction the default: an
// unrecognised verb is treated as a write, and a genuine read is one word away
// from being exempted here.
//
// Extending this list is the DANGEROUS direction, and `fetch` is the worked
// example. It looks like the safest possible addition — the most common read
// verb in the language, with three synonyms already listed (`get`, `load`,
// `read`) — and adding it silently un-flagged
// `data-subscriptions-section.tsx`'s `handleUnsubscribe`, whose mutation is a
// paged POST loop through a helper called `fetchStepWithRetry`. That is the
// single most destructive handler the baseline names. A verb here must be one
// no MUTATION in this tree could be prefixed by, which "fetch" is not; when in
// doubt leave it off and take the false positive, because over-inclusion costs
// a baseline line and under-inclusion costs a live bug.
const READ_VERB =
  /^(get|list|find|search|count|build|load|read|is|has|can|should|format|parse|derive|compute|select|resolve|to|map|filter|sort|group|pick|use|make|new|calc|estimate|score|rank|match|diff|compare|validate|check|infer|extract|summar|render|describe|label|title|display)/i;
const ALWAYS_MUTATING = new Set(["apiSend", "withToastOnError"]);

// A JSX prop that takes an event handler, for the inline form below. Every DOM
// and React event prop is `on` + a capital, and so is every handler prop this
// app passes to its own components.
const JSX_HANDLER_PROP = /^on[A-Z]/;

// The cost of a denylist default is a read whose verb is not on the list, and
// the cost of NOT having a hatch is that the only recourse is editing the
// baseline — which reads in review as "this is unguarded debt" rather than
// "this is not a mutation". Two different statements deserve two different
// spellings. This was also the only check here with no opt-out at all.
const REENTRY_SAFE_OPT_OUT = /(?:\/\/|\/\*|\*)\s*reentry-safe:/;

/**
 * True when an `apiFetch` call carries a mutating request init.
 *
 * `apiFetch` is the READ helper, so treating every call as a read looks right
 * — but section f only routes STATUS-ONLY mutations through `apiSend`. A
 * mutation whose response body matters correctly uses `apiFetch` with
 * `jsonBody(...)` or an explicit non-GET method, and every one of those was
 * invisible: a PUT of an API key, a POST that imports a contact, a POST that
 * spends scrape budget.
 */
function apiFetchMutates(call, sf) {
  const init = call.arguments[1];
  if (!init) return false;
  const text = init.getText(sf);
  return /\bjsonBody\s*\(/.test(text) || /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(text);
}

/**
 * Names this file imports from a module that can mutate, in EVERY import shape.
 *
 * The named-imports-only version was a third silent exemption alongside the
 * handler-name filter: `import api from "@/lib/x"` and
 * `import * as api from "@/lib/x"` both bound a live seam that the scan could
 * not see, so a mutation through either read as no seam at all — and since an
 * empty seam set skips the file outright, one such import hid every handler in
 * it. Namespaces come back separately because they are called as `api.send()`,
 * a property access rather than a bare identifier.
 *
 * Type-only imports are excluded in both spellings (`import type { … }` and
 * `import { type X }`). A type is not callable, so it can never be the mutating
 * call this looks for — but it does make the seam set non-empty, which is the
 * test for whether the file is worth scanning at all.
 */
function seamImports(sf) {
  const names = new Set();
  const namespaces = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!SEAM_MODULE.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    // `import api from "@/lib/x"`
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      // The LOCAL name, so `import { apiSend as send }` is tracked as `send`.
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) names.add(el.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { names, namespaces };
}

/**
 * A real re-entry guard: a ref that is READ to bail out, and CLAIMED before the
 * first await.
 *
 * All three properties are load-bearing, and a first version of this check
 * required none of them — it matched any `<x>Ref.current = true` anywhere in
 * the subtree, which meant:
 *
 *   `await apiSend(…); savingRef.current = true;`   passed, and guards nothing
 *   `savingRef.current = true` with no read at all  passed, and guards nothing
 *   `hoveredRef.current = true` in a nested callback passed, unrelated entirely
 *
 * That is worse than a miss, because the ratchet's stale-entry direction turns
 * it into a one-way door: adding one cosmetic line does not merely PERMIT
 * deleting a baseline entry, it COMPELS it, converting a live defect into a
 * permanent "fixed" with nothing behind it.
 *
 * Name-agnostic on purpose. The old `/Ref$/` filter rejected
 * `const saving = useRef(false)` — a correct guard, and a spelling already used
 * elsewhere in this app — while the READ requirement discriminates far better:
 * `inputRef.current?.focus()` has no early-return read, so it cannot be
 * mistaken for a guard no matter what it is called. Two claim shapes are
 * accepted: a whole-handler flag, and CAR-204's per-identity Set/Map for a list
 * whose rows submit independently.
 */
function claimsReentryGuard(fn, sf) {
  // Everything before the first await is "before the first await".
  let firstAwait = Infinity;
  const findAwait = (n) => {
    if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getStart(sf));
    ts.forEachChild(n, findAwait);
  };
  findAwait(fn);

  // Refs whose `.current` is read in a condition that bails out.
  const readToBail = new Set();
  const findReads = (n) => {
    if (ts.isIfStatement(n) && n.thenStatement) {
      const bails = /\breturn\b/.test(n.thenStatement.getText(sf));
      if (bails) {
        const collect = (c) => {
          if (
            ts.isPropertyAccessExpression(c) &&
            c.name.text === "current" &&
            ts.isIdentifier(c.expression)
          ) {
            readToBail.add(c.expression.text);
          }
          ts.forEachChild(c, collect);
        };
        collect(n.expression);
      }
    }
    ts.forEachChild(n, findReads);
  };
  findReads(fn);
  if (readToBail.size === 0) return false;

  // …and is then claimed, before the first await.
  let claimed = false;
  const findClaim = (n) => {
    if (claimed) return;
    if (n.getStart(sf) < firstAwait) {
      // <x>.current = <anything>
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "current" &&
        ts.isIdentifier(n.left.expression) &&
        readToBail.has(n.left.expression.text)
      ) {
        claimed = true;
        return;
      }
      // <x>.current.add(…) / .set(…)
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        (n.expression.name.text === "add" || n.expression.name.text === "set") &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "current" &&
        ts.isIdentifier(n.expression.expression.expression) &&
        readToBail.has(n.expression.expression.expression.text)
      ) {
        claimed = true;
        return;
      }
    }
    ts.forEachChild(n, findClaim);
  };
  findClaim(fn);
  return claimed;
}

/** The function a declaration initialises, unwrapping useCallback/useMemo. */
function initialiserFunction(decl) {
  let init = decl.initializer;
  if (!init) return null;
  if (ts.isCallExpression(init) && /^(useCallback|useMemo)$/.test(init.expression.getText(decl.getSourceFile()))) {
    init = init.arguments[0];
  }
  if (!init) return null;
  return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
}

const isAsyncFn = (fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

/**
 * Known-unguarded mutation handlers, as of CAR-208.
 *
 * 129 sites across 55 files. It was 54 across 29 at CAR-190, and 35 before
 * that; neither earlier figure was a measurement of the codebase, both were
 * measurements of a detector. CAR-190 removed five blind spots and found 19
 * more. CAR-208 removed three more and found 75:
 *
 *   the HANDLER NAME FILTER, which required `/^(handle|on)[A-Z]/` and so
 *     inspected a mutation called `handleAdd` while ignoring the identical one
 *     called `addContact` — 58 functions, including the live double-click bug
 *     this ticket fixed in admin/contacts-section.tsx;
 *   INLINE JSX HANDLERS, `onClick={async () => { await apiSend(…) }}`, which
 *     have no declaration to hang a name on and were invisible as a class — 17;
 *   NON-NAMED IMPORT SHAPES, where a default or namespace import of a `@/lib`
 *     module bound a seam the scan could not resolve, and an empty seam set
 *     skips the whole file.
 *
 * The same pass removed two FALSE positives the name filter had been hiding by
 * accident: server files were never excluded here, so an async React Server
 * Component and a Route Handler outside src/app/api both surfaced the moment
 * arbitrary names were in scope. Neither has double-submit semantics; the check
 * now skips server files as (g) and (h) already did.
 *
 * The list is deliberately OVER-inclusive, and reading it as "129 double-click
 * bugs" would be wrong. `mutates()` judges a callee by its verb against a
 * denylist of read verbs, so pure helpers whose names happen not to look like
 * reads (`jsonBody`, `defaultPipelineState`, `createSupabaseBrowserClient`)
 * count as writes, and a handler one hop from a real write counts alongside the
 * helper it calls. That asymmetry is chosen: over-inclusion costs a line here,
 * under-inclusion costs a live bug, and the READ_VERB note above records what
 * happened the one time this was tuned the other way.
 *
 * Draining the list is a sweep of its own, not this ticket's job; the guard's
 * job is that it can only shrink. Two entries deserve to go first —
 * `data-subscriptions-section.tsx`'s `handleSubscribe` and `handleUnsubscribe`
 * are non-idempotent and one of them POSTs a destructive contact-removal loop,
 * with no synchronous guard at all.
 */
const DOUBLE_SUBMIT_BASELINE = {
  "src/app/action-items/page.tsx": ["cyclePriority", "onClick", "restoreItem", "saveEdit"],
  "src/app/admin/users/page.tsx": ["setAiPolicy", "setScrapeControl"],
  "src/app/calendar/page.tsx": ["handleDeleteEvent", "handleSaveMeeting", "handleSync", "loadData"],
  "src/app/companies/[id]/page.tsx": ["handleSetTier", "load"],
  "src/app/contacts/[id]/page.tsx": ["handleDelete"],
  "src/app/contacts/page.tsx": ["handleActivate", "handleSetTier", "onClick"],
  "src/app/contacts/preview/page.tsx": ["handleSave"],
  "src/app/interactions/page.tsx": ["handleDeleteInteraction", "handleSubmit"],
  "src/app/meetings/page.tsx": [
    "handleMeetingAttachmentDelete",
    "handleMeetingAttachmentUpload",
    "onClick",
    "onClick",
    "onClick",
    "onResolve",
  ],
  "src/app/oauth/consent/page.tsx": ["decide"],
  "src/app/page.tsx": ["handleDismiss", "handleSnooze", "loadSchedule", "markActionDone"],
  "src/app/reset-password/page.tsx": ["handleSubmit"],
  "src/components/admin/account-section.tsx": ["deleteAccount", "setStatus"],
  "src/components/admin/ai-section.tsx": ["setPolicy"],
  "src/components/admin/automatic-features-section.tsx": ["setEnabled"],
  "src/components/admin/bundle-access-list.tsx": ["put", "setOverride"],
  "src/components/admin/contacts-section.tsx": ["fire"],
  "src/components/admin/premium-section.tsx": ["setEnabled"],
  "src/components/admin/profile-section.tsx": ["handleSave"],
  "src/components/admin/scraping-section.tsx": ["setControl"],
  "src/components/admin/security-section.tsx": ["changeRole", "generateLink", "setPassword"],
  "src/components/ai/ai-unavailable-notice.tsx": ["requestAccess"],
  "src/components/auth-provider.tsx": ["signOut", "signUp"],
  "src/components/availability-picker.tsx": ["onClick"],
  "src/components/companies/add-company-modal.tsx": ["submit"],
  "src/components/companies/discovery-card.tsx": ["act"],
  "src/components/companies/person-modal.tsx": ["handleMarkContacted"],
  "src/components/companies/pipeline/manage-offices-panel.tsx": ["addOffice", "onClick"],
  "src/components/companies/pipeline/pipeline-file-upload.tsx": ["handleFile", "handleRemove"],
  "src/components/compose-email-modal.tsx": [
    "autoSave",
    "createFollowUpRecords",
    "deleteDraft",
    "generateFollowUps",
    "onClick",
    "onClick",
    "onGenerate",
    "onSkip",
    "runFollowUps",
    "saveDraft",
  ],
  "src/components/contacts/contact-actions-tab.tsx": ["onClick", "onClick"],
  "src/components/contacts/contact-attachments-tab.tsx": ["handleDelete", "handleUpload"],
  "src/components/contacts/contact-edit-modal.tsx": ["onSubmit"],
  "src/components/contacts/contact-emails-tab.tsx": [
    "cancelFollowUp",
    "confirmMessage",
    "handleExpandEmail",
    "markReplied",
    "retryScheduledEmail",
  ],
  "src/components/contacts/contact-follow-up-status.tsx": ["handleCancel"],
  "src/components/contacts/contact-pending-actions-banner.tsx": ["handleComplete"],
  "src/components/contacts/contact-profile-card.tsx": [
    "handleActivate",
    "handlePhotoRemove",
    "handlePhotoSelected",
    "handleScrape",
    "saveCadence",
    "saveEmail",
  ],
  "src/components/contacts/contact-timeline-tab.tsx": [
    "handleDeleteInteraction",
    "handleSaveInteraction",
  ],
  "src/components/contacts/resolve-linkedin-modal.tsx": ["link"],
  "src/components/conversation-modal/past-meeting-fields.tsx": ["handleAudioFile"],
  "src/components/email/inbox/inbox-shell.tsx": [
    "cancelFollowUp",
    "deleteDraft",
    "handleExpandEmail",
    "handleHideEmail",
    "handleMoveEmail",
    "handleRestoreEmail",
    "handleTrashEmail",
    "handleUnhideEmail",
  ],
  "src/components/email/inbox/use-inbox-data.ts": ["handleSync"],
  "src/components/email/outreach/outreach-shell.tsx": [
    "cancelDraft",
    "confirmFollowUp",
    "retryScheduledEmail",
  ],
  "src/components/follow-up-modal.tsx": ["handleSave", "onClick"],
  "src/components/meetings/transcript-action-suggestions.tsx": [
    "acceptSuggestion",
    "extractActions",
  ],
  "src/components/onboarding/extension-onboarding-modal.tsx": [
    "advance",
    "completeTodo",
    "handleDeclineApollo",
    "handleDeleteTask",
    "handleStart",
    "poll",
  ],
  "src/components/onboarding/onboarding-flow.tsx": ["onPicked", "tick"],
  "src/components/settings/account-section.tsx": [
    "handlePasswordChange",
    "handleSave",
    "toggleNudges",
  ],
  "src/components/settings/availability-section.tsx": [
    "handleSaveAvailability",
    "handleSaveBusyCalendars",
  ],
  "src/components/settings/data-subscriptions-section.tsx": [
    "handleSubscribe",
    "handleUnsubscribe",
    "runApplyLoop",
  ],
  "src/components/settings/integrations-section.tsx": [
    "handleDisconnectCalendar",
    "handleGmailDisconnect",
    "handleGmailSync",
  ],
  "src/components/settings/provider-key-card.tsx": ["handleSave"],
  "src/components/settings/templates-section.tsx": ["handleDelete", "handleSave"],
  "src/hooks/use-pipeline-autosave.ts": ["resolveTargetId"],
  "src/hooks/use-suggestions.ts": ["dismiss", "load", "saveSuggestion"],
};

{
  const rows = [];
  for (const file of CLIENT_FILES) {
    const sf = parse(file);
    // Server files are skipped for the same reason (g) and (h) skip them, and
    // this check should always have done so: a Route Handler outside
    // src/app/api (three exist) and an async React Server Component have no
    // double-submit semantics at all — there is no second click to block, and
    // a `useRef` is not available to them. The handler-name filter hid this by
    // accident, since `GET` and `AdminLayout` are not spelled like handlers;
    // dropping that filter surfaced both as violations of a rule that cannot
    // apply to them.
    if (isServerFile(sf, file)) continue;
    const { names: seams, namespaces } = seamImports(sf);
    if (seams.size === 0 && namespaces.size === 0) continue;

    /** Does this subtree perform a write, directly or through one local hop? */
    const mutates = (fn, localHelpers) => {
      let hit = false;
      const visit = (n) => {
        if (hit) return;
        if (ts.isCallExpression(n)) {
          // `send(…)` from a named or default import, or a local helper.
          if (ts.isIdentifier(n.expression)) {
            const callee = n.expression.text;
            if (seams.has(callee)) {
              if (callee === "apiFetch") {
                if (apiFetchMutates(n, sf)) hit = true;
              } else if (ALWAYS_MUTATING.has(callee) || !READ_VERB.test(callee)) {
                hit = true;
              }
              if (hit) return;
            } else if (localHelpers?.has(callee)) {
              // One hop through a helper declared in this file. The mutating call
              // otherwise sits outside the handler's own subtree and is invisible
              // — the shape `handleDeclineApollo` uses via `completeTodo()`.
              hit = true;
              return;
            }
          } else if (
            // `api.send(…)` from a namespace import. Judged on the MEMBER name,
            // which is the seam's own export name, so the read/write verb rules
            // apply unchanged.
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            namespaces.has(n.expression.expression.text)
          ) {
            const member = n.expression.name.text;
            if (member === "apiFetch") {
              if (apiFetchMutates(n, sf)) hit = true;
            } else if (ALWAYS_MUTATING.has(member) || !READ_VERB.test(member)) {
              hit = true;
            }
            if (hit) return;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
      return hit;
    };

    // File-local functions that themselves write. Collected first so a handler
    // calling one of them counts as mutating.
    const localHelpers = new Set();
    {
      const collect = (node) => {
        let name = null;
        let fn = null;
        if (ts.isFunctionDeclaration(node) && node.name) {
          name = node.name.text;
          fn = node;
        } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
          fn = initialiserFunction(node);
          if (fn) name = node.name.text;
        }
        if (name && fn && mutates(fn)) localHelpers.add(name);
        ts.forEachChild(node, collect);
      };
      collect(sf);
    }

    const visit = (node) => {
      let name = null;
      let fn = null;
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        fn = node;
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        fn = initialiserFunction(node);
        if (fn) name = node.name.text;
      } else if (ts.isJsxAttribute(node) && JSX_HANDLER_PROP.test(node.name.getText(sf))) {
        // `onClick={async () => { await apiSend(…) }}` — a handler with no
        // declaration to hang a name on. Keyed by the PROP name, which is
        // stable across the line moves a raw line number would not survive;
        // two of the same prop in one file are two baseline slots, which the
        // ratchet's multiset accounting already handles.
        const init = node.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
        if (expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))) {
          name = node.name.getText(sf);
          fn = expr;
        }
      }
      if (
        name &&
        fn &&
        isAsyncFn(fn) &&
        mutates(fn, localHelpers) &&
        !claimsReentryGuard(fn, sf) &&
        !REENTRY_SAFE_OPT_OUT.test(annotationAbove(sf, node))
      ) {
        rows.push({ file, name, line: lineOf(sf, node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  report(
    "mutation handler without a double-submit guard",
    [
      ...diffNamedRatchet(byFile(rows), DOUBLE_SUBMIT_BASELINE, CLIENT_FILE_SET, BASELINE_HOME),
      ...deadBaselinePaths(DOUBLE_SUBMIT_BASELINE),
    ],
    "A mutation handler blocks re-entry with a synchronous ref, read and set\n" +
      "  before the first await and reset in finally:\n" +
      "    const savingRef = useRef(false);\n" +
      "    if (savingRef.current) return;\n" +
      "    savingRef.current = true;\n" +
      "  A boolean state flag will not do: `disabled={saving}` has not rendered\n" +
      "  when the second click of a double click arrives, and no disabled\n" +
      "  attribute gates an onKeyDown path at all (CONVENTIONS.md section f).",
  );
}

// ── (j) identity-keyed async read must gate on useLatestRequest ──────────
//
// The classic out-of-order bug: the user opens contact A then contact B, A's
// slower response resolves last, and B's view fills with A's data. Claim a
// token with begin(), gate the setState on isLatest(token).
//
// Candidate shape: a useEffect/useCallback whose dependency array carries an
// identity (an `id`/`…Id`), whose body awaits, and which then calls a setter
// with a value DERIVED from that await. The derivation requirement is what
// makes this precise rather than noisy — without it the same scan flags 23
// sites, most of them callbacks keyed on a UI-state id like `confirmingId`
// that never race anything.
//
// WHAT THIS CANNOT SEE. Heuristic, like (i), and narrower than it looks:
//
//   * the identity test is LEXICAL. A dependency spelled `slug`, `email` or
//     `selected` keys a racing read just as surely as one spelled `contactId`,
//     and none of them match;
//   * the derivation test is TEXTUAL — a setter argument is "derived" when the
//     awaited binding's name appears in it, so a value laundered through an
//     intermediate variable breaks the link and the site goes quiet;
//   * a race across TWO effects — one writes what the other reads — has no
//     single body to inspect and is out of reach entirely;
//   * idiom 3, the AbortController, is still recognised by a text match for
//     `new AbortController(` plus the word `signal` anywhere in the body. It
//     does not verify the signal reaches the request. That one is a stub, and
//     the reason it survives is that no site here relies on it.
//
// Idioms 1 and 2 are checked structurally: `gatesStaleCommit` requires the gate
// to stand between the response and EVERY commit, not merely to appear nearby.

/**
 * Identity-keyed reads that commit an ungated result, as of CAR-208.
 *
 * SEVEN sites, and the literal below is the count that matters — this header
 * said "8" against seven entries from the day it was written, which is the same
 * class of unchecked claim CAR-208 exists to close. The one the audit named —
 * the outreach page, where two getCompanyDetail calls raced and the page
 * rendered one company's header over another's employees — is FIXED rather
 * than listed.
 *
 * The membership is unchanged by CAR-208's rewrite of `gatesStaleCommit`, which
 * moved in both directions at once: recognising `let mounted = true` stopped
 * one class of false positive, and requiring the flag to actually stand between
 * the response and the commit stopped a false negative. Neither shape happened
 * to be present in this tree, so the seven are the same seven — a coincidence
 * worth stating, because "the baseline did not move" reads like "nothing
 * changed" and here it does not mean that.
 */
const LATEST_REQUEST_BASELINE = {
  "src/app/admin/users/[id]/page.tsx": ["load"],
  "src/app/contacts/[id]/page.tsx": ["loadContact"],
  "src/app/interactions/page.tsx": ["loadInteractions"],
  "src/components/admin/contacts-section.tsx": ["load"],
  "src/components/compose-email-modal.tsx": ["generateFollowUps"],
  "src/components/contacts/contact-follow-up-status.tsx": ["loadSequences"],
  "src/components/meetings/transcript-action-suggestions.tsx": ["extractActions"],
};

// snake_case included: this app's DB columns are snake_case throughout, so
// `person.contact_id` is as much an identity as `contactId` and the
// camelCase-only form silently exempted it.
const IDENTITY_DEP = /(^|[._])(id|\w+_id)$|[a-z0-9]Id$/;

const LATEST_REQUEST_OPT_OUT = /(?:\/\/|\/\*|\*)\s*latest-request-exempt:/;

/** Every identifier bound anywhere in a binding pattern, at any nesting. */
function* bindingNames(name) {
  if (ts.isIdentifier(name)) {
    yield name.text;
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el) && el.name) yield* bindingNames(el.name);
    }
  }
}

/**
 * True when this callback body gates its commit against a superseded response.
 *
 * THREE idioms count, not one. The first version of this check accepted only
 * `useLatestRequest`, which made a false positive out of the canonical React
 * fix: a `let cancelled = false` closed over by the effect and flipped in its
 * cleanup is used at eight sites here and is entirely correct — React runs the
 * cleanup before the next effect, so a stale response cannot commit. Listing
 * such a site as a violation is worse than a miss, because the ratchet then
 * fails when it is "fixed", and the only way to clear the entry is to rewrite
 * already-correct code.
 *
 * It also matched `isLatest` as TEXT, so a comment mentioning it satisfied the
 * gate — the very bypass check (f) was hardened against one screen up in the
 * same commit. The AST guard beside it was dead code: it required a bare
 * `isLatest(…)` call, while every real site spells it `req.isLatest(token)`.
 */
function gatesStaleCommit(body, sf, commits) {
  // 1. useLatestRequest — bare or member call, never mere prose.
  let gated = false;
  const findGate = (n) => {
    if (gated) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === "isLatest") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "isLatest")
      ) {
        gated = true;
        return;
      }
    }
    ts.forEachChild(n, findGate);
  };
  findGate(body);
  if (gated) return true;

  // 2. A cancellation flag: declared at one polarity, flipped to the other in
  //    the effect cleanup, and consulted in a way that ACTUALLY GATES the
  //    commit.
  //
  //    Two independent defects lived here (CAR-208).
  //
  //    ONE POLARITY. The idiom was recognised only as `let cancelled = false`
  //    flipped to `true`. `let mounted = true` flipped to `false` in the
  //    cleanup is the same pattern written the other way round, is at least as
  //    common in React code, and was reported as a violation — the worst
  //    outcome for a ratchet, because "fixing" a correct site means rewriting
  //    it to the spelling the detector happens to know.
  //
  //    EXISTENCE, NOT GATING. The three facts were collected independently over
  //    the whole body and then intersected by NAME, so any unrelated boolean
  //    triple satisfied the rule for every commit in the effect. `let done =
  //    false; … done = true; … if (done) log()` silenced a completely separate
  //    ungated setState three statements away. The flag now has to stand
  //    between the response and the commit, in one of the two shapes this app
  //    writes: an early return positioned after the await and before the
  //    commit, or a condition that encloses the commit.
  const flagged = new Map(); // name → { declared: boolean, flipped: boolean }
  const note = (name, key) => {
    const e = flagged.get(name) ?? { declared: false, flipped: false };
    e[key] = true;
    flagged.set(name, e);
  };
  const scan = (n) => {
    // `let cancelled = false` / `let mounted = true`
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const k = n.initializer?.kind;
      if (k === ts.SyntaxKind.FalseKeyword || k === ts.SyntaxKind.TrueKeyword) {
        note(n.name.text, "declared");
      }
    }
    // …flipped to the OPPOSITE literal somewhere (the cleanup).
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      (n.right.kind === ts.SyntaxKind.TrueKeyword || n.right.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      note(n.left.text, "flipped");
    }
    ts.forEachChild(n, scan);
  };
  scan(body);

  /** Does this expression consult `flag`? */
  const consults = (expr, flag) => {
    let hit = false;
    const walk = (c) => {
      if (hit) return;
      if (ts.isIdentifier(c) && c.text === flag) {
        hit = true;
        return;
      }
      ts.forEachChild(c, walk);
    };
    walk(expr);
    return hit;
  };

  // Everything before the first await is not yet racing anything: a flag read
  // there was decided before the response existed, so it gates nothing.
  let firstAwait = Infinity;
  const findAwait = (n) => {
    if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getStart(sf));
    ts.forEachChild(n, findAwait);
  };
  findAwait(body);

  /** An `if (flag) return;` that sits after the await and before `commit`. */
  const bailsBefore = (flag, commit) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isIfStatement(n) && n.thenStatement && consults(n.expression, flag)) {
        const bails = /\breturn\b/.test(n.thenStatement.getText(sf));
        const afterAwait = firstAwait === Infinity || n.getStart(sf) > firstAwait;
        if (bails && afterAwait && n.end <= commit.getStart(sf)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  };

  /** A condition that ENCLOSES `commit` and consults `flag`. */
  const enclosedBy = (flag, commit) => {
    let n = commit;
    while (n && n !== body) {
      const p = n.parent;
      if (!p) break;
      if (ts.isIfStatement(p) && n !== p.expression && consults(p.expression, flag)) return true;
      if (ts.isConditionalExpression(p) && n !== p.condition && consults(p.condition, flag)) return true;
      if (
        ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        n === p.right &&
        consults(p.left, flag)
      ) {
        return true;
      }
      n = p;
    }
    return false;
  };

  for (const [flag, { declared, flipped }] of flagged) {
    if (!declared || !flipped) continue;
    // EVERY commit, not any: a body that gates one setState and leaves the next
    // one bare still races on the bare one.
    if (commits.every((c) => bailsBefore(flag, c) || enclosedBy(flag, c))) return true;
  }

  // 3. An AbortController whose signal is threaded into the request.
  const text = body.getText(sf);
  if (/new AbortController\s*\(/.test(text) && /\bsignal\b/.test(text)) return true;

  return false;
}

{
  const rows = [];
  for (const file of CLIENT_FILES) {
    const sf = parse(file);

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^(useEffect|useCallback)$/.test(node.expression.text) &&
        node.arguments.length === 2 &&
        ts.isArrayLiteralExpression(node.arguments[1])
      ) {
        const body = node.arguments[0];
        const deps = node.arguments[1].elements.map((e) => e.getText(sf));

        if (deps.some((d) => IDENTITY_DEP.test(d))) {
          // Locals bound to an await, so a later setState(x) can be traced back
          // to the response rather than to unrelated local state. EVERY name in
          // the binding tree counts: requiring a plain identifier made
          // `const { rows } = await …` and `const [a, b] = await Promise.all(…)`
          // invisible, and those are the dominant shapes for a multi-read
          // loader — the same blind spot tripwire (c) shipped with, which this
          // file's own test header records as the reason it exists.
          const awaited = new Set();
          const collectAwaited = (n) => {
            if (n.initializer && ts.isAwaitExpression(n.initializer) && n.name) {
              if (ts.isIdentifier(n.name)) awaited.add(n.name.text);
              else for (const bound of bindingNames(n.name)) awaited.add(bound);
            }
            ts.forEachChild(n, collectAwaited);
          };
          collectAwaited(body);
          // `.then(d => setX(d))` commits just as surely as an awaited binding.
          const thenParams = new Set();
          const collectThen = (n) => {
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              n.expression.name.text === "then" &&
              n.arguments[0] &&
              (ts.isArrowFunction(n.arguments[0]) || ts.isFunctionExpression(n.arguments[0]))
            ) {
              for (const p of n.arguments[0].parameters) {
                if (ts.isIdentifier(p.name)) thenParams.add(p.name.text);
                else for (const bound of bindingNames(p.name)) thenParams.add(bound);
              }
            }
            ts.forEachChild(n, collectThen);
          };
          collectThen(body);

          // The commit NODES, not merely whether one exists: the gate check
          // below has to ask, of each one, whether a cancellation flag stands
          // between it and the response.
          const commits = [];
          const derived = [...awaited, ...thenParams];
          const findCommit = (n) => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^set[A-Z]/.test(n.expression.text)) {
              const arg = n.arguments.map((a) => a.getText(sf)).join(",");
              if (/\bawait\b/.test(arg) || derived.some((a) => new RegExp(`\\b${a}\\b`).test(arg))) {
                commits.push(n);
                return;
              }
            }
            ts.forEachChild(n, findCommit);
          };
          findCommit(body);

          if (
            commits.length > 0 &&
            !gatesStaleCommit(body, sf, commits) &&
            !LATEST_REQUEST_OPT_OUT.test(annotationAbove(sf, node))
          ) {
            // Label by the enclosing const where there is one, so the entry
            // survives the line moves that a raw line number would not.
            const decl = ts.findAncestor(node, ts.isVariableDeclaration);
            const name =
              decl && decl.name && ts.isIdentifier(decl.name) ? decl.name.text : node.expression.text;
            rows.push({ file, name, line: lineOf(sf, node) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  report(
    "identity-keyed read without useLatestRequest",
    [
      ...diffNamedRatchet(byFile(rows), LATEST_REQUEST_BASELINE, CLIENT_FILE_SET, BASELINE_HOME),
      ...deadBaselinePaths(LATEST_REQUEST_BASELINE),
    ],
    "This read is keyed on an identity that can change while it is in flight,\n" +
      "  so a slower earlier response can overwrite a newer one. Claim a token and\n" +
      "  gate the commit, via useLatestRequest from src/hooks/use-latest-request.ts:\n" +
      "    const token = req.begin();\n" +
      "    const data = await load(id);\n" +
      "    if (!req.isLatest(token)) return;\n" +
      "    setThing(data);",
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
const countBaseline = (b) => Object.values(b).reduce((n, v) => n + (Array.isArray(v) ? v.length : v), 0);

console.log(
  "✓ conventions guard: queries.ts barrel frozen; no module-scope client in src/lib/{data,rules};\n" +
    "  CAS shape clean in src/{lib,app,mcp}; unchecked reads clean in src/lib + src/app/api/cron;\n" +
    `  ${MCP_DB} within its ${MCP_DB_BASELINE} baseline; MCP launches carry ${REACT_SERVER_FLAG};\n` +
    `  every test mock of the ${Object.keys(SHARED_MOCK_FACTORIES).length} shared-factory modules goes through its typed factory;\n` +
    // Interpolated, never hardcoded. This line is an affirmative claim about
    // what was inspected, and a literal one keeps making that claim verbatim
    // after the scope changes underneath it — including, as measured, against
    // an EMPTY tree. The file's own closing note argues that naming the scope
    // beats a bare "all clean"; a specific claim that nothing verifies is worse
    // than a vague one, because it is more convincing.
    `  client tree (${CLIENT_ROOTS.join(" + ")} minus the API routes and server files,\n` +
    `  ${CLIENT_FILES.length} files) free of raw fetch( and native confirm(), plus no first-party\n` +
    "  /api fetch anywhere else under src/; double-submit and useLatestRequest\n" +
    `  ratchets at ${countBaseline(DOUBLE_SUBMIT_BASELINE)}/${countBaseline(LATEST_REQUEST_BASELINE)} known sites — each can only shrink.`,
);

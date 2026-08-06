#!/usr/bin/env node
/**
 * CI guard (CAR-158, CAR-187, CAR-190, CAR-208): conventions that tsc and
 * eslint cannot express, each of which has already cost a real incident or a
 * real audit finding.
 *
 * FOURTEEN checks under thirteen labels — (a) reports twice, once per half. Keep
 * this list and the count in CONVENTIONS.md section d in step with the code; both
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
 *   Read scale (CAR-223, CAR-229)
 *   (m) a multi-row read that declares no bound at all, and so truncates
 *       silently at PostgREST's 1000 rows.
 *   (n) a read in src/lib/data or company-queries.ts that pages a table to
 *       EXHAUSTION with nothing but the tenant key narrowing it.
 *   (o) a `.range()` window over a query carrying no `.order()`.
 *
 * There is no (k). It checked that a `fixed inset-0` overlay outside modal.tsx
 * carried role="dialog", and CAR-208 deleted it as a duplicate of
 * `src/__tests__/dialog-adoption.test.ts`. Two guards for one rule was not
 * merely redundant, it was a trap — they accepted near-anagram escape hatches,
 * `// overlay-not-a-dialog:` here and `// non-dialog-overlay:` there, and
 * neither accepted the other's. The first contributor with a legitimate
 * non-dialog overlay would have written whichever token the error they hit
 * first named, and stayed red against the other.
 *
 * The two were COMPLEMENTARY, not ordered, and the first cut of this deletion
 * claimed the survivor was "stricter" — which was false in the direction that
 * mattered. (k) matched `fixed` and `inset-0` as independent tokens; the
 * survivor matched the contiguous string, so a reordered or interpolated class
 * list went from caught to unenforced. (k)'s rule has been ported into the
 * survivor rather than lost with it. The survivor is genuinely stronger on the
 * other side — a class list hoisted into a const, which (k) could not see at
 * all — so the consolidation is still right; it just had to carry both halves.
 *
 * The comment-annotation vocabulary a contributor can write is NINE tokens,
 * down from ten: six here (cas-checked, error-tolerated, typed-mock-exempt,
 * raw-fetch, reentry-safe, latest-request-exempt), two in
 * dialog-adoption.test.ts (non-dialog-overlay, body-portal) and one in
 * migration-destructive-guard.test.ts (destructive-resync-audited). A first
 * draft of this line said "seven, down from eight" by counting only this file
 * plus the one token the deletion touched — a smaller claim than it sounded,
 * made without enumerating.
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

// "Browser-reached" is decided by IMPORT GRAPH, not by directory. A relative
// `/api/...` URL only resolves in a browser, so the module that writes one is
// client code wherever it lives, and no directory line can be the test for
// that. The guard therefore walks OUT from the client files and bans every raw
// fetch in what it reaches (CAR-207).
//
// Where the rule applies, and why it is three scopes rather than one:
//
//   - the CLIENT TREE bans every raw fetch, first-party or not, because client
//     code has no business hand-rolling a request at all;
//   - every BROWSER-REACHABLE module outside it gets that same total ban,
//     because the tree boundary is not the runtime boundary (see below);
//   - EVERYWHERE ELSE under src/, a fetch at a literal `/api/...` URL is still
//     a violation, because a relative URL only resolves in a browser. That
//     third scope exists because the first one is trivially escaped by an
//     ordinary refactor: hoisting a call out of a component into a `src/lib`
//     helper is a change a reviewer would ASK for, and it silently left the
//     freeze. Six such calls were already sitting there, two of them
//     hand-rolling the exact `!res.ok → parse → throw` dance apiFetch exists to
//     delete.
//
// The second scope is CAR-207's. CAR-190 added the third believing it closed
// the `src/lib` hole, and it did not: a URL-literal test cannot see a call whose
// URL is a PARAMETER. `bundle-apply-client.ts`'s retry helper took the path as
// an argument and POSTed to /api/bundles/apply and /api/bundles/unsubscribe from
// the browser, invisibly, for as long as the guard had existed. Widening the
// DIRECTORY scope — which the ticket proposed — would have fixed nothing, since
// src/lib was already scanned. What was missing is the principle this header
// opens with: reachability, not location, is what makes a module client code.
//
// src/lib/api-client.ts is the sanctioned wrapper and is exempt by definition.
const API_CLIENT = "src/lib/api-client.ts";

/**
 * Modules outside the client tree that a browser nonetheless loads, by import
 * graph from the client files.
 *
 * Runtime edges only: a `import type` is erased, so it cannot carry a module
 * into the bundle, and counting it would drag server modules in through their
 * types alone. Seeds exclude server files for the same reason — in a React
 * Server Component `fetch` IS the idiomatic data call, and nothing it imports
 * reaches a browser through that edge.
 *
 * Measured before this rule was written, because a guard's blast radius is a
 * claim that deserves evidence: 68 modules are reachable this way, and exactly
 * two of them contain a raw `fetch` — api-client.ts (exempt above) and the
 * defect. All six third-party fetchers under src/lib (serper, apify/client,
 * notify/email, admin-actions, admin-notify, import-db-helpers) are unreachable
 * from the client, so this lands at zero rather than needing a baseline.
 */
const BROWSER_REACHABLE = (() => {
  /**
   * Resolve an import specifier to a file in this repo, or null for a package.
   *
   * Handles `@/` and relative specifiers only. tsconfig also declares `@ext`
   * and `@panel` into ../chrome-extension, which are deliberately out of scope:
   * the scan universe is walk("src"), so an entry over there could never be
   * reported anyway, and following the edge would only slow the walk.
   */
  const resolveSpec = (spec, fromFile) => {
    let base;
    if (spec.startsWith("@/")) {
      base = `src/${spec.slice(2)}`;
    } else if (spec.startsWith(".")) {
      const parts = [];
      for (const seg of `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      base = parts.join("/");
    } else {
      return null;
    }
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(base + suffix)) return base + suffix;
    }
    return null;
  };

  /** In-repo modules this file pulls in at RUNTIME. */
  const runtimeImports = (sf, r) => {
    const out = [];
    const add = (spec) => {
      if (!spec || !ts.isStringLiteral(spec)) return;
      const target = resolveSpec(spec.text, r);
      if (target) out.push(target);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) {
        add(st.moduleSpecifier);
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
        add(st.moduleSpecifier);
      }
    }
    // Dynamic `import("…")` too, anywhere in the file: `next/dynamic` and a
    // lazily-imported parser both put the target in a browser chunk exactly
    // like a static import, so a rule about what the browser loads has to see
    // them. Statement-level scanning alone cannot — these sit in expression
    // position, usually inside a callback.
    const visitExpressions = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visitExpressions);
    };
    visitExpressions(sf);
    return out;
  };

  const seen = new Set();
  const queue = [];
  for (const file of CLIENT_FILES) {
    if (isServerFile(parse(file), file)) continue;
    seen.add(file);
    queue.push(file);
  }
  while (queue.length > 0) {
    const cur = queue.pop();
    for (const dep of runtimeImports(parse(cur), cur)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return new Set(
    [...seen].filter((r) => !CLIENT_FILE_SET.has(r) && r !== API_CLIENT && !isTestFile(r)),
  );
})();

{
  const violations = [];
  const everywhere = [...new Set([...CLIENT_FILES, ...walk("src", []).map(rel)])]
    .filter((r) => !isTestFile(r) && !r.startsWith("src/app/api/") && r !== API_CLIENT)
    .sort();

  for (const file of everywhere) {
    const sf = parse(file);
    if (isServerFile(sf, file)) continue;
    const bannedOutright = CLIENT_FILE_SET.has(file) || BROWSER_REACHABLE.has(file);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isBare = ts.isIdentifier(callee) && callee.text === "fetch";
        const isGlobal =
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fetch" &&
          /^(window|globalThis|global|self)$/.test(callee.expression.getText(sf));
        if ((isBare || isGlobal) && (bannedOutright || fetchesFirstPartyApi(node, sf))) {
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
//
// Each verb is followed by a camelCase BOUNDARY — the next character must not be
// another lowercase letter. Bare prefix matching was silently exempting four
// classes of mutation, because the short verbs are prefixes of long writes:
// `can` swallowed `cancel*`, `to` swallowed `toggle*`, `is` swallowed `issue*`
// and `check` swallowed `checkout*`. Of five mutations named that way, exactly
// one was flagged. `cancel` is not hypothetical here — `@/lib/data/emails`
// exports `cancelFollowUpSequenceCascade` and `cancelScheduledEmailCascade`.
//
// `summar` keeps prefix semantics deliberately (summarize/summary), so it sits
// outside the boundary group. The regex is case-SENSITIVE: under /i the
// `(?![a-z])` lookahead would also reject an uppercase next character, which is
// the common case (`getFoo`), inverting the whole list.
const READ_VERB =
  /^(?:summar|(?:get|list|find|search|count|build|load|read|is|has|can|should|format|parse|derive|compute|select|resolve|to|map|filter|sort|group|pick|use|make|new|calc|estimate|score|rank|match|diff|compare|validate|check|infer|extract|render|describe|label|title|display)(?![a-z]))/;
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
  /** local name → EXPORTED name, which is what the verb rules are about. */
  const names = new Map();
  const namespaces = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!SEAM_MODULE.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    // `import api from "@/lib/x"` — callable as `api(…)` AND as `api.send(…)`,
    // so the default binding goes in BOTH sets. Registering it only as a name
    // left the member-call spelling invisible, which is the very shape this
    // function's docblock offers as its motivating example.
    if (clause.name) {
      names.set(clause.name.text, clause.name.text);
      namespaces.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      // Keyed by the LOCAL name (that is what the call site writes) but VALUED
      // by the exported one. Classifying the local name inverted the verdict in
      // both directions: `import { apiFetch as af }` lost its read status and
      // `import { apiSend as getIt }` gained one, because `apiFetch`,
      // ALWAYS_MUTATING and READ_VERB are all statements about the export.
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) names.set(el.name.text, (el.propertyName ?? el.name).text);
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
  //
  // The walk stops at NESTED functions, in both directions. Descending made
  // `firstAwait` the position of an await inside a not-yet-called callback, so
  // declaring a helper arrow above the guard pushed the guard "after the first
  // await" and a textbook-correct handler was flagged — clearable only by
  // reordering correct code.
  let firstAwait = Infinity;
  const findAwait = (n) => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getStart(sf));
    ts.forEachChild(n, findAwait);
  };
  findAwait(fn);

  // Refs whose `.current` is read in a condition that bails out.
  const readToBail = new Set();
  const findReads = (n) => {
    if (ts.isIfStatement(n) && n.thenStatement) {
      // Either branch may hold the bail: `if (!busy.current) { claim } else
      // { return }` is the same guard written inside out.
      const bails =
        /\breturn\b/.test(n.thenStatement.getText(sf)) ||
        (n.elseStatement ? /\breturn\b/.test(n.elseStatement.getText(sf)) : false);
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

  // …and is then claimed, before the first await, ON THIS FUNCTION'S OWN PATH.
  //
  // The walk used to descend into nested functions and accept any assignment
  // whose source position preceded the first await. That let three shapes that
  // guard nothing read as guarded: a claim inside a `.finally()` or
  // `queueMicrotask` callback (runs after), a claim inside a conditional branch
  // (guards one path), and `ref.current = false` (a release, not a claim). This
  // direction matters more than a miss: the ratchet's stale-entry rule does not
  // merely permit deleting the baseline line, it COMPELS it, converting a live
  // defect into a permanent "fixed" with nothing behind it.
  let claimed = false;
  const findClaim = (n) => {
    if (claimed) return;
    if (n !== fn && ts.isFunctionLike(n)) return; // a deferred claim is not a claim
    if (n.getStart(sf) < firstAwait) {
      // <x>.current = <truthy>
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "current" &&
        ts.isIdentifier(n.left.expression) &&
        readToBail.has(n.left.expression.text) &&
        n.right.kind !== ts.SyntaxKind.FalseKeyword
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

/**
 * True when some enclosing function already claims a re-entry guard.
 *
 * A nested helper declared inside a guarded handler cannot be re-entered while
 * the outer guard is held, so reporting it is a second row for one logical
 * submit path — and one that can never be cleared on its own terms, since the
 * fix (the outer guard) is already there. Without this, the ordinary shape
 * `const save = async () => { const doIt = async () => {…}; if (busy.current)
 * return; busy.current = true; await doIt(); }` produced a violation for `doIt`
 * on code whose guard is exactly right.
 */
function enclosedByGuardedFunction(node, sf) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionLike(n) && claimsReentryGuard(n, sf)) return true;
    n = n.parent;
  }
  return false;
}

/**
 * True when a synchronous function kicks off async work it does not await.
 *
 * `onClick={() => withToastOnError(async () => { … })}` starts a mutation on
 * click and returns immediately; the second click of a double click is not
 * blocked by anything. Judged by an async function appearing anywhere in the
 * subtree, which is the shape every fire-and-forget call site here uses.
 */
function startsAsyncWork(fn) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n !== fn && isAsyncFn(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(fn);
  return found;
}

/**
 * The function an initialiser expression denotes, unwrapping useCallback/useMemo
 * and parentheses.
 *
 * `React.useCallback` counts as well as the bare import — matching only
 * `/^(useCallback|useMemo)$/` meant the qualified spelling produced no candidate
 * at all.
 */
function unwrapFunction(init) {
  if (!init) return null;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init && ts.isCallExpression(init)) {
    const callee = init.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
    if (/^(useCallback|useMemo)$/.test(name)) init = init.arguments[0];
  }
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (!init) return null;
  return ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
}

/** The function a declaration initialises. */
function initialiserFunction(decl) {
  return unwrapFunction(decl.initializer);
}

const isAsyncFn = (fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

/**
 * Known-unguarded mutation handlers, as of CAR-208.
 *
 * 129 sites across 53 files, 20 of them inline JSX handlers. It was 54 across
 * 29 at CAR-190, and 35 before that; neither earlier figure was a measurement
 * of the codebase, both were measurements of a detector. CAR-190 removed five
 * blind spots and found 19 more. CAR-208 removed three, then a review of
 * CAR-208 removed seven more — the second pass is why the number moved twice.
 *
 * First pass:
 *
 *   the HANDLER NAME FILTER, which required `/^(handle|on)[A-Z]/` and so
 *     inspected a mutation called `handleAdd` while ignoring the identical one
 *     called `addContact` — 58 functions, among them the two unguarded submits
 *     in admin/contacts-section.tsx (an earlier draft of this note called those
 *     a live double-click bug; that claim did not survive being tested — see
 *     the comment on `submittingRef` there);
 *   INLINE JSX HANDLERS, `onClick={async () => { await apiSend(…) }}`, which
 *     have no declaration to hang a name on and were invisible as a class — 20
 *     once the second pass below stopped requiring them to be `async`;
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
 * Second pass, from the review of the first — four more misses and three more
 * false positives, every one of them found by executing the detector rather
 * than by reading it:
 *
 *   READ_VERB matched BARE PREFIXES, so `can` swallowed `cancel*`, `to`
 *     swallowed `toggle*`, `is` swallowed `issue*` and `check` swallowed
 *     `checkout*`. Of five mutations named that way, one was flagged;
 *   inline handlers were required to be `async`, so the fire-and-forget half of
 *     the class stayed invisible — the SAME create-tag button was baselined in
 *     its `onClick={async …}` spelling and missed in its
 *     `onClick={() => withToastOnError(async …)}` spelling, in two files;
 *   OBJECT METHODS and property assignments were candidates in no shape, which
 *     is how `useDeferredAction({ action: async … })` was invisible;
 *   `claimsReentryGuard` accepted a claim deferred into a callback, made in one
 *     branch, or setting `false` — a bogus guard that does not merely permit
 *     deleting a baseline line, it COMPELS it, converting a live defect into a
 *     permanent "fixed" with nothing behind it;
 *   …while rejecting a handler that forwards to a correctly guarded helper, a
 *     guard written `if (!busy.current) {…} else { return; }`, and any guard
 *     with a nested async helper declared above it (`findAwait` descended into
 *     not-yet-called functions, so the guard read as "after the first await").
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
 * job is that it can only shrink — and it has, twice, from both ends. CAR-207
 * drained the three files it had open for other defects: the two entries this
 * note used to nominate as most urgent (`data-subscriptions-section.tsx`'s
 * `handleSubscribe`, which raced its own UNIQUE constraint into a 500 the user
 * read as failure, and `handleUnsubscribe`, which POSTs a destructive
 * contact-removal loop) went first exactly as asked;
 * `contact-attachments-tab.tsx`'s pair went with the confirm dialog its delete
 * should always have had; and `interactions/page.tsx` left the list entirely,
 * because that route is now a redirect with no handlers in it at all.
 */
const DOUBLE_SUBMIT_BASELINE = {
  "src/app/action-items/page.tsx": [
    "action",
    "action",
    "cyclePriority",
    "onClick~tjgw",
    "restoreItem",
    "saveEdit",
  ],
  "src/app/admin/users/page.tsx": ["setAiPolicy", "setScrapeControl"],
  "src/app/calendar/page.tsx": ["handleDeleteEvent", "handleSaveMeeting", "handleSync", "loadData"],
  "src/app/companies/[id]/page.tsx": ["handleSetTier", "load"],
  "src/app/contacts/[id]/page.tsx": ["handleDelete"],
  "src/app/contacts/page.tsx": ["handleActivate", "handleSetTier", "onClick~aqoh"],
  "src/app/contacts/preview/page.tsx": ["handleSave"],
  "src/app/meetings/page.tsx": [
    "handleMeetingAttachmentDelete",
    "handleMeetingAttachmentUpload",
    "onClick~11fy",
    "onClick~17tt",
    "onClick~1ci0",
    "onClick~1ktz",
    "onClick~3m7y",
    "onClick~z7cv",
    "onResolve~19d0",
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
  "src/components/availability-picker.tsx": ["onClick~dglu"],
  "src/components/companies/add-company-modal.tsx": ["submit"],
  "src/components/companies/discovery-card.tsx": ["act"],
  "src/components/companies/person-modal.tsx": ["handleMarkContacted"],
  "src/components/companies/pipeline/manage-offices-panel.tsx": ["addOffice", "onClick~3gdn"],
  "src/components/companies/pipeline/pipeline-file-upload.tsx": ["handleFile", "handleRemove"],
  "src/components/compose-email-modal.tsx": [
    "autoSave",
    "createFollowUpRecords",
    "deleteDraft",
    "generateFollowUps",
    "onClick~1315",
    "onClick~15va",
    "onGenerate~4c2u",
    "onSkip~rn7b",
    "runFollowUps",
    "saveDraft",
  ],
  "src/components/contacts/contact-actions-tab.tsx": [
    "action",
    "action",
    "onClick~8sza",
    "onClick~y02s",
  ],
  "src/components/contacts/contact-edit-modal.tsx": ["onClick~99bx"],
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
  "src/components/follow-up-modal.tsx": ["handleSave", "onClick~xyo6"],
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
  "src/components/onboarding/onboarding-flow.tsx": ["onPicked~e503"],
  // CAR-217 drained "toggleNudges": its twin toggleBounceAlerts was added in
  // the same file, and guarding one while baselining the other would have
  // frozen a second copy of the identical bug.
  "src/components/settings/account-section.tsx": [
    "handlePasswordChange",
    "handleSave",
  ],
  "src/components/settings/availability-section.tsx": [
    "handleSaveAvailability",
    "handleSaveBusyCalendars",
  ],
  "src/components/settings/data-subscriptions-section.tsx": ["runApplyLoop"],
  "src/components/settings/integrations-section.tsx": [
    "handleDisconnectCalendar",
    "handleGmailDisconnect",
    "handleGmailSync",
  ],
  "src/components/settings/provider-key-card.tsx": ["handleSave"],
  "src/components/settings/templates-section.tsx": ["handleDelete", "handleSave"],
  "src/hooks/use-pipeline-autosave.ts": ["resolveTargetId"],
  // `load` left this list in CAR-229: its only mutation is now the generate
  // request, and `runGenerate` claims a synchronous in-flight ref before its
  // first await and releases it in finally.
  "src/hooks/use-suggestions.ts": ["dismiss", "saveSuggestion"],
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

    /** Classify one seam call by its EXPORTED name. */
    const callMutates = (node, exported) => {
      if (exported === "apiFetch") return apiFetchMutates(node, sf);
      return ALWAYS_MUTATING.has(exported) || !READ_VERB.test(exported);
    };

    /**
     * Does this subtree write? `hops` collects the local helpers it reached, so
     * the caller can ask whether the write was DIRECT or borrowed from a helper.
     */
    const mutates = (fn, localHelpers, hops) => {
      let hit = false;
      const visit = (n) => {
        if (hit) return;
        if (ts.isCallExpression(n)) {
          // `send(…)` from a named or default import, or a local helper.
          if (ts.isIdentifier(n.expression)) {
            const callee = n.expression.text;
            if (seams.has(callee)) {
              if (callMutates(n, seams.get(callee))) hit = true;
              if (hit) return;
            } else if (localHelpers?.has(callee)) {
              // One hop through a helper declared in this file. The mutating call
              // otherwise sits outside the handler's own subtree and is invisible
              // — the shape `handleDeclineApollo` uses via `completeTodo()`.
              hops?.add(callee);
              hit = true;
              return;
            }
          } else if (
            // `api.send(…)` from a namespace or default import. Judged on the
            // MEMBER name, which is the seam's own export name, so the read/write
            // verb rules apply unchanged.
            ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) &&
            namespaces.has(n.expression.expression.text)
          ) {
            if (callMutates(n, n.expression.name.text)) hit = true;
            if (hit) return;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
      return hit;
    };

    /** True when this subtree writes WITHOUT borrowing a local helper's write. */
    const mutatesDirectly = (fn) => mutates(fn, null, null);

    // File-local functions that themselves write. Collected first so a handler
    // calling one of them counts as mutating.
    //
    // NOT filtered to async functions, though a review recommended it. A
    // non-async helper that RETURNS the promise carries the mutation perfectly
    // well, and this file's own `security-section.tsx` is written that way:
    // `const post = (path, body) => apiFetch(path, jsonBody(body))`. Requiring
    // async silently un-flagged its three admin mutations — set a password,
    // change a role, mint a password link — which is a far worse trade than the
    // cascade the filter was meant to stop. That cascade (a pure helper reading
    // as mutating because its callee's name is not a read verb) is real, but it
    // is the over-inclusive direction, and no instance of it exists in the tree.
    const localHelperFns = new Map();
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
        } else if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name && ts.isIdentifier(node.name)) {
          fn = ts.isMethodDeclaration(node) ? node : unwrapFunction(node.initializer);
          if (fn) name = node.name.text;
        }
        if (name && fn && mutatesDirectly(fn)) {
          localHelpers.add(name);
          localHelperFns.set(name, fn);
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);
    }

    /**
     * A stable identity for an inline JSX handler.
     *
     * The prop name ALONE reduced this named ratchet to a counted one for the
     * inline form: every inline handler in a file collapses to the string
     * `onClick`, so a baselined offender could be correctly guarded while a
     * brand-new unguarded destructive handler was added in the same file, and
     * the counts still matched. ratchet.mjs's own header gives that exact
     * trade-a-fix-for-a-fresh-one scenario as the reason named beats counted.
     *
     * The discriminator is a short digest of the handler body, which keeps the
     * property the prop name was chosen for (it survives the line moves a raw
     * line number would not) while changing the moment the handler is replaced
     * or guarded — which is precisely when the baseline SHOULD be re-examined.
     */
    const inlineKey = (prop, fn) => {
      const text = fn.getText(sf).replace(/\s+/g, " ");
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
      return `${prop}~${(h >>> 0).toString(36).slice(0, 4)}`;
    };

    /**
     * True when this handler's ONLY mutation is a call to a local helper that
     * already carries the guard.
     *
     * `mutates()` follows one local hop but `claimsReentryGuard()` does not, so
     * a thin forwarder — `onSubmit={async (e) => { e.preventDefault(); await
     * handleSave(); }}` over a correctly guarded `handleSave` — read as
     * unguarded. Those entries are the worst kind of baseline line: the code is
     * already right, so the ratchet's stale direction can never retire them, and
     * the docblock says a baseline line "reads in review as unguarded debt".
     */
    const forwardsToGuardedHelper = (fn) => {
      if (mutatesDirectly(fn)) return false;
      const hops = new Set();
      mutates(fn, localHelpers, hops);
      if (hops.size === 0) return false;
      return [...hops].every((h) => {
        const helper = localHelperFns.get(h);
        return helper && claimsReentryGuard(helper, sf);
      });
    };

    const visit = (node) => {
      let name = null;
      let fn = null;
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        fn = node;
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        fn = initialiserFunction(node);
        if (fn) name = node.name.text;
      } else if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name && ts.isIdentifier(node.name)) {
        // `{ async save() {…} }` and `{ save: async () => {…} }` — the shape
        // `useDeferredAction({ action: … })` uses. Neither is a variable or a
        // function declaration, so both were candidates in no shape at all.
        fn = ts.isMethodDeclaration(node) ? node : unwrapFunction(node.initializer);
        if (fn) name = node.name.text;
      } else if (ts.isJsxAttribute(node) && JSX_HANDLER_PROP.test(node.name.getText(sf))) {
        const init = node.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
        if (expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))) {
          fn = expr;
          name = inlineKey(node.name.getText(sf), expr);
        }
      }
      if (
        name &&
        fn &&
        // A non-async inline handler that STARTS an async mutation is exactly as
        // re-entrant as an awaited one: `onClick={() => withToastOnError(async
        // () => { await createTag(…) })}` creates two rows on a double click.
        // Requiring async saw only half the inline class — the same create-tag
        // button was baselined in its async spelling and invisible in its
        // synchronous one, in two different files.
        (isAsyncFn(fn) || (ts.isJsxAttribute(node) && startsAsyncWork(fn))) &&
        mutates(fn, localHelpers, null) &&
        !claimsReentryGuard(fn, sf) &&
        !forwardsToGuardedHelper(fn) &&
        !enclosedByGuardedFunction(node, sf) &&
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
 * SIX sites, and the literal below is the count that matters — this header once
 * said "8" against seven entries from the day it was written, which is the same
 * class of unchecked claim CAR-208 exists to close. The one the audit named —
 * the outreach page, where two getCompanyDetail calls raced and the page
 * rendered one company's header over another's employees — is FIXED rather
 * than listed. CAR-207 took it from seven to six by turning
 * `interactions/page.tsx` into a redirect, which left its `loadInteractions`
 * with nothing to race.
 *
 * MEMBERSHIP is otherwise unchanged by CAR-208's rewrite of `gatesStaleCommit`,
 * which moved in both directions at once: recognising `let mounted = true`
 * stopped one class of false positive, requiring the flag to stand between the
 * response and every commit stopped a false negative, and per-commit await
 * positioning stopped another of each. None of those shapes happened to be
 * present in this tree — worth stating, because "the baseline barely moved"
 * reads like "nothing changed" and here it does not mean that.
 */
const LATEST_REQUEST_BASELINE = {
  "src/app/admin/users/[id]/page.tsx": ["load"],
  "src/app/contacts/[id]/page.tsx": ["loadContact"],
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
  // Positions of every await in the body, so the "is this check downstream of
  // the response?" question can be asked PER COMMIT.
  //
  // A single body-global `firstAwait` was wrong in both directions (CAR-208
  // review). It rejected a correct `.then`-guarded read the moment any
  // unrelated await appeared later in the same effect — eight live files pair a
  // cancellation flag with `.then(`, so one added await would have turned a
  // correct file red. And it accepted a bail that preceded the RACING await as
  // long as some earlier unrelated await existed, which defeated this check's
  // own "consulted only BEFORE the await" test.
  const awaitStarts = [];
  const findAwait = (n) => {
    if (ts.isAwaitExpression(n)) awaitStarts.push(n.getStart(sf));
    ts.forEachChild(n, findAwait);
  };
  findAwait(body);
  /** The last await that could have produced `commit`'s value. */
  const awaitBefore = (commit) => {
    const before = awaitStarts.filter((a) => a < commit.getStart(sf));
    return before.length > 0 ? Math.min(...before) : Infinity;
  };

  /**
   * True when `guard` is on `commit`'s straight-line path — i.e. `commit` is
   * inside the statement list that `guard` bails out of.
   *
   * Source position alone is not dominance, and treating it as such is how the
   * "existence, not gating" defect survived its own fix. `n.end <= start` only
   * says "appears earlier in the file", so a bail inside one async IIFE cleared
   * a bare commit inside the NEXT one, a bail in a `.catch` cleared a commit in
   * a later `.then`, and a never-called helper containing `if (flag) return;`
   * cleared everything after it. Swapping two semantically identical IIFEs
   * flipped the verdict, which is the tell.
   */
  const dominates = (guard, commit) => {
    let n = commit;
    while (n && n !== body) {
      if (n.parent === guard.parent) return true;
      n = n.parent;
    }
    return false;
  };

  /** A `return` or `throw` belonging to THIS block, not to a nested function. */
  const bailsOut = (stmt) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isFunctionLike(n)) return; // a return inside a callback is not a bail
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(stmt);
    return found;
  };

  // 1. useLatestRequest. Held to the SAME per-commit standard as idiom 2 —
  //    anything else would leave standing the exact "one call anywhere in the
  //    body clears every commit" defect that this check's own header claims to
  //    have closed. A dead-branch `isLatest`, one positioned after the commit,
  //    or one belonging to an unrelated object all used to pass.
  const latestGates = [];
  const findGate = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === "isLatest") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "isLatest")
      ) {
        latestGates.push(n);
      }
    }
    ts.forEachChild(n, findGate);
  };
  findGate(body);

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
  // The two polarities are PAIRED, not collected independently. Recording
  // "declared a boolean" and "assigned a boolean" as separate facts accepted a
  // cleanup that assigns the SAME value it was declared with — `let cancelled =
  // false; … cancelled = false;` — which is a real bug (the flag never trips,
  // every stale response commits) that the pre-CAR-208 check caught.
  const flagged = new Map(); // name → { declaredTrue, declaredFalse, setTrue, setFalse }
  const note = (name, key) => {
    const e = flagged.get(name) ?? {
      declaredTrue: false,
      declaredFalse: false,
      setTrue: false,
      setFalse: false,
    };
    e[key] = true;
    flagged.set(name, e);
  };
  const scan = (n) => {
    // `let cancelled = false` / `let mounted = true`
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const k = n.initializer?.kind;
      if (k === ts.SyntaxKind.FalseKeyword) note(n.name.text, "declaredFalse");
      if (k === ts.SyntaxKind.TrueKeyword) note(n.name.text, "declaredTrue");
    }
    // …flipped to the OPPOSITE literal somewhere (the cleanup).
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      if (n.right.kind === ts.SyntaxKind.TrueKeyword) note(n.left.text, "setTrue");
      if (n.right.kind === ts.SyntaxKind.FalseKeyword) note(n.left.text, "setFalse");
    }
    ts.forEachChild(n, scan);
  };
  scan(body);

  /**
   * Does this expression consult `flag`?
   *
   * Property NAMES are skipped: without that, `if (opts.cancelled)` satisfies a
   * local flag that happens to be called `cancelled`, which is a different
   * variable entirely.
   */
  const consults = (expr, flag) => {
    let hit = false;
    const walk = (c) => {
      if (hit) return;
      if (ts.isPropertyAccessExpression(c)) {
        walk(c.expression); // the object, never the member name
        return;
      }
      if (ts.isIdentifier(c) && c.text === flag) {
        hit = true;
        return;
      }
      ts.forEachChild(c, walk);
    };
    walk(expr);
    return hit;
  };

  /** An `if (flag) return;` downstream of the response and dominating `commit`. */
  const bailsBefore = (flag, commit) => {
    const racingAwait = awaitBefore(commit);
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isIfStatement(n) && n.thenStatement && consults(n.expression, flag)) {
        const afterAwait = racingAwait === Infinity || n.getStart(sf) > racingAwait;
        if (bailsOut(n.thenStatement) && afterAwait && n.end <= commit.getStart(sf) && dominates(n, commit)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  };

  /** A condition that ENCLOSES `commit`, consults `flag`, and sits after the response. */
  const enclosedBy = (flag, commit) => {
    const racingAwait = awaitBefore(commit);
    // An enclosing gate decided BEFORE the request was issued protects nothing —
    // the same mistake `bailsBefore` rejects, written as a wrapper instead of an
    // early return.
    const afterAwait = (cond) => racingAwait === Infinity || cond.getStart(sf) > racingAwait;
    let n = commit;
    while (n && n !== body) {
      const p = n.parent;
      if (!p) break;
      if (ts.isIfStatement(p) && n !== p.expression && consults(p.expression, flag) && afterAwait(p.expression)) {
        return true;
      }
      if (
        ts.isConditionalExpression(p) &&
        n !== p.condition &&
        consults(p.condition, flag) &&
        afterAwait(p.condition)
      ) {
        return true;
      }
      if (
        ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        n === p.right &&
        consults(p.left, flag) &&
        afterAwait(p.left)
      ) {
        return true;
      }
      n = p;
    }
    return false;
  };

  // EVERY commit must be gated — but not necessarily by the SAME flag. Demanding
  // one flag cover all of them rejected the correct one-flag-per-in-flight-request
  // shape, so the quantifiers are: every commit, gated by some flag.
  const usable = [...flagged].filter(
    ([, f]) => (f.declaredFalse && f.setTrue) || (f.declaredTrue && f.setFalse),
  );
  if (
    commits.length > 0 &&
    commits.every((c) => usable.some(([flag]) => bailsBefore(flag, c) || enclosedBy(flag, c)))
  ) {
    return true;
  }

  // …and idiom 1 under the same rule.
  if (
    commits.length > 0 &&
    commits.every((c) =>
      latestGates.some((g) => {
        const stmt = ts.findAncestor(g, ts.isIfStatement);
        return (
          (stmt && bailsOut(stmt.thenStatement) && stmt.end <= c.getStart(sf) && dominates(stmt, c)) ||
          isAncestorCondition(g, c)
        );
      }),
    )
  ) {
    return true;
  }

  // 3. An AbortController whose signal is threaded into the request.
  //
  // AST-matched, not text-matched: `body.getText()` includes comments and string
  // contents, so a `// TODO: switch to new AbortController() and pass the signal`
  // above a bare ungated commit cleared the whole effect. That is the identical
  // bypass class this file hardened check (f) and idiom 1 against.
  let abortWired = false;
  const findAbort = (n) => {
    if (abortWired) return;
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "AbortController") {
      abortWired = true;
      return;
    }
    ts.forEachChild(n, findAbort);
  };
  findAbort(body);
  if (abortWired) {
    // …and the signal actually reaches a call, rather than merely being named.
    let signalPassed = false;
    const findSignal = (n) => {
      if (signalPassed) return;
      if (ts.isPropertyAccessExpression(n) && n.name.text === "signal") {
        signalPassed = true;
        return;
      }
      if (ts.isShorthandPropertyAssignment(n) && n.name.text === "signal") {
        signalPassed = true;
        return;
      }
      ts.forEachChild(n, findSignal);
    };
    findSignal(body);
    if (signalPassed) return true;
  }

  return false;
}

/** True when `gate` appears in a condition that encloses `commit`. */
function isAncestorCondition(gate, commit) {
  const cond = ts.findAncestor(gate, (a) => ts.isIfStatement(a) || ts.isConditionalExpression(a));
  if (!cond) return false;
  let n = commit;
  while (n) {
    if (n === cond) return true;
    n = n.parent;
  }
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
            if (
              ts.isCallExpression(n) &&
              ts.isIdentifier(n.expression) &&
              /^set[A-Z]/.test(n.expression.text) &&
              // `setTimeout`/`setInterval` match /^set[A-Z]/ and carry `await` in
              // their callback's text, so a timer was recorded as a React commit
              // that must be gated. That flagged effects containing no setState
              // at all, and under the every-commit rule it turned correct polling
              // effects red.
              !/^set(Timeout|Interval|Immediate)$/.test(n.expression.text)
            ) {
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

// ── (m) unbounded multi-row PostgREST reads ──────────────────────────────
//
// PostgREST caps a response at 1000 rows and truncates SILENTLY — no error, no
// signal, just a short list that reads as the whole table. CAR-221 shipped the
// first user-visible instance: /api/gmail/inbox built its contact id → name map
// from an unpaginated whole-table read, so a user with 2005 contacts got names
// for 1000 of them and bare email addresses for the rest. CAR-223 found ~15
// more, several already live, including one in bundle-sync whose truncation
// FAILS TOWARD DELETION.
//
// A read counts as bounded if its chain declares .limit()/.range(), terminates
// in .single()/.maybeSingle(), or is a head-count. Everything else is
// inventoried below.
//
// Read the baseline as "reads this detector cannot PROVE bounded", not as 142
// bugs. Three things land in it innocently: a table too small to ever reach the
// cap (locations, data_bundles); a read narrowed by an .in() over a handful of
// ids, which bounds it in practice but says nothing syntactically; and a chain
// split across statements (`let q = ...; await q.range(...)`), where the
// .range() is real but not reachable from the .from() node. Deciding which is
// which statically is not possible, so the guard does not try.
//
// Ratcheted rather than banned for exactly that reason. What the ratchet buys
// is the part that matters: no NEW unbounded read can appear, and every one
// that gets fixed must leave the baseline — see scripts/lib/ratchet.mjs for why
// that beats a warning.
//
// To clear an entry: page it with paginateAll() (or chunkedPaginated() when the
// table fans out per id), give it a deliberate .limit(), or narrow it to a
// keyed .single(). Then delete its line below.

const UNBOUNDED_READ_BASELINE = {
  "src/app/api/admin/users/[id]/bundle-access/route.ts": ["bundle_access_overrides", "bundle_subscriptions", "data_bundles"],
  "src/app/api/admin/users/[id]/contacts/route.ts": ["contacts"],
  "src/app/api/admin/users/route.ts": ["bundle_access_overrides", "data_bundles", "user_ai_access", "user_api_keys"],
  "src/app/api/calendar/events/[googleEventId]/route.ts": ["meetings"],
  "src/app/api/calendar/events/route.ts": ["calendar_events"],
  "src/app/api/calendar/sync/route.ts": ["calendar_events", "contact_emails"],
  "src/app/api/contacts/bulk-import/backfill/route.ts": ["company_locations", "locations"],
  "src/app/api/contacts/check-duplicate/route.ts": ["contact_emails", "contact_schools", "contacts", "contacts"],
  "src/app/api/contacts/import/route.ts": ["company_locations", "contact_companies", "contact_companies", "contact_emails", "contact_schools", "contact_schools", "contacts"],
  "src/app/api/cron/follow-up-nudges/route.ts": ["users"],
  // The second email_follow_up_messages read and contacts.ts's contact_emails
  // read are both bounded by an .in() over a chunked list, which the detector
  // cannot see. Inventoried, not defects.
  "src/app/api/cron/send-follow-ups/route.ts": ["email_follow_up_messages", "email_follow_up_messages", "gmail_connections"],
  "src/app/api/cron/sync-bundles/route.ts": ["data_bundles"],
  "src/app/api/discovery/candidates/route.ts": ["discovery_candidates"],
  "src/app/api/gmail/ai-followups/generate/route.ts": ["ai_follow_up_drafts"],
  "src/app/api/gmail/ai-followups/pending/route.ts": ["ai_follow_up_drafts"],
  "src/app/api/gmail/ai-write/meetings/route.ts": ["meeting_contacts"],
  "src/app/api/gmail/drafts/route.ts": ["email_drafts"],
  "src/app/api/gmail/emails/route.ts": ["contact_emails", "email_messages"],
  "src/app/api/gmail/follow-ups/[id]/route.ts": ["email_follow_up_messages"],
  "src/app/api/gmail/follow-ups/route.ts": ["email_follow_ups"],
  "src/app/api/gmail/inbox/route.ts": ["calendar_events", "email_follow_ups", "scheduled_emails"],
  "src/app/api/gmail/schedule/route.ts": ["scheduled_emails"],
  "src/app/api/gmail/templates/route.ts": ["email_templates"],
  "src/app/meetings/page.tsx": ["calendar_events"],
  "src/lib/ai-followup/gather-context.ts": ["meeting_contacts", "transcript_segments"],
  "src/lib/ai-followup/generate-suggestions.ts": ["contacts", "follow_up_action_items", "follow_up_action_items"],
  "src/lib/ai-helpers.ts": ["meetings"],
  "src/lib/analytics/server.ts": ["contact_companies"],
  "src/lib/apify/cadence.ts": ["scrape_runs", "suppressed_imports"],
  "src/lib/apify/discovery.ts": ["contacts", "contacts", "discovery_candidates", "scrape_runs", "target_companies"],
  "src/lib/apify/scrape-service.ts": ["companies", "contacts", "contacts", "scrape_runs"],
  "src/lib/apify/spend.ts": ["scrape_runs"],
  "src/lib/bulk-import.ts": ["companies", "company_locations", "contact_companies", "contact_emails", "contact_schools", "contacts", "contacts", "schools", "suppressed_imports"],
  "src/lib/bundle-publish.ts": ["bundle_prospects"],
  "src/lib/bundle-queue.ts": ["bundle_subscriptions"],
  "src/lib/bundle-resolve.ts": ["company_locations", "schools"],
  "src/lib/bundle-sync.ts": ["bundle_contact_state", "bundle_subscription_contacts", "bundle_subscription_contacts", "bundle_subscription_contacts", "contacts", "contacts"],
  "src/lib/company-helpers.ts": ["companies", "companies", "companies", "locations"],
  "src/lib/company-queries.ts": ["companies", "company_locations", "contact_schools", "locations", "target_company_notes"],
  "src/lib/company-scopes.ts": ["target_companies"],
  "src/lib/contact-employment.ts": ["contact_companies", "contact_emails", "contacts"],
  "src/lib/data/action-items.ts": ["action_item_contacts", "action_item_contacts", "follow_up_action_items"],
  "src/lib/data/attachments.ts": ["contact_attachments", "meeting_attachments"],
  "src/lib/data/contacts.ts": ["contact_change_events", "contact_emails", "contact_tags", "tags"],
  "src/lib/data/interactions.ts": ["interactions"],
  "src/lib/data/locations.ts": ["locations"],
  "src/lib/data/meetings.ts": ["attachments", "contact_attachments", "interaction_attachments", "meeting_attachments", "meeting_attachments", "meeting_contacts", "meetings"],
  "src/lib/email-send.ts": ["contact_emails"],
  "src/lib/follow-up-helpers.ts": ["email_follow_ups"],
  "src/lib/gmail.ts": ["contact_emails", "contact_emails", "email_follow_ups", "email_messages", "email_messages", "email_messages"],
  "src/lib/import-db-helpers.ts": ["contact_tags", "tags"],
  "src/lib/onboarding/bundle-stats.ts": ["data_bundles"],
  "src/lib/pipeline-queries.ts": ["pipeline_applications", "pipeline_cycles", "pipeline_interview_rounds", "pipeline_notes", "pipeline_programs", "target_companies", "target_companies"],
  "src/lib/user-status.ts": ["users"],
};

/** The outermost call of the chain this `.from()` starts, so the check can see
 *  the .limit()/.range()/.single() that come AFTER .select(). */
function postgrestChainRoot(fromCall) {
  let cur = fromCall;
  for (;;) {
    const p = cur.parent;
    if (!p) return cur;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) { cur = p; continue; }
    if (ts.isCallExpression(p) && p.expression === cur) { cur = p; continue; }
    return cur;
  }
}

{
  const rows = [];
  const scanned = new Set();
  const files = [...walk("src/lib", []), ...walk("src/app", []), ...walk("src/mcp", [])];
  for (const file of files) {
    const r = rel(file);
    if (isTestFile(r)) continue;
    // MCP_DB carries its own dedicated `.from(` ratchet (check (d)); two guards
    // owning one file means two baselines to keep in step, and its raw-builder
    // count is the number that actually matters there.
    if (r === MCP_DB) continue;
    scanned.add(r);
    const sf = parse(file);

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "from"
      ) {
        const arg = node.arguments[0];
        // A computed table name is unknowable statically; there are none today.
        if (arg && ts.isStringLiteral(arg)) {
          const text = postgrestChainRoot(node).getText(sf);
          const isWrite = /\.(insert|update|upsert|delete)\s*\(/.test(text);
          const isKeyed = /\.(single|maybeSingle)\s*\(/.test(text);
          const isBounded = /\.(limit|range)\s*\(/.test(text);
          const isHeadCount = /head:\s*true/.test(text);
          const isRead = /\.select\s*\(/.test(text);
          if (isRead && !isWrite && !isKeyed && !isBounded && !isHeadCount) {
            rows.push({ file: r, name: arg.text, line: lineOf(sf, node) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  report(
    "unbounded multi-row read",
    diffNamedRatchet(byFile(rows), UNBOUNDED_READ_BASELINE, scanned, BASELINE_HOME),
    "PostgREST truncates a response at 1000 rows without erroring, so this read\n" +
      "  silently returns a partial set that the code then treats as complete.\n" +
      "  Page it with paginateAll() from src/lib/data/postgrest.ts (or\n" +
      "  chunkedPaginated() when the table fans out per id) with a stable\n" +
      "  .order(), or give it a deliberate .limit(). A ratchet: new sites are\n" +
      "  never allowed, and a fixed site must be deleted from the baseline.",
  );
}

// ── (n) exhaustive pagination in the data layer ──────────────────────────
//
// Check (m) is about CORRECTNESS: a read that never pages truncates at 1000
// rows. This one is about COST, and the two are disjoint by construction —
// every paginateAll() body carries `.range(from, to)`, so (m) already counts it
// as bounded and never looks at it again.
//
// The failure mode is the one CAR-92/93/94/96 kept re-fixing: a page whose load
// time is a function of the account's total row count. Dawson's account has
// 2,005 contacts, so a paginateAll() over `contacts` is three PostgREST round
// trips before the handler can start work, and /contacts measured 14.8s.
//
// e2e/request-budget.spec.ts does NOT cover this, which is why both guards
// exist. Inside an /api handler a sweep is one browser request however slow;
// on the pages that read the data layer from the browser it is counted, but
// only bills an extra request past a 1,000-row page — so at any seeded test
// scale a sweep and a keyed read look identical. That guard owns fan-out; this
// one owns sweeps.
//
// A sweep is EXHAUSTIVE unless something bounds it independently of how much
// data the tenant has:
//   - `.limit(...)` anywhere in the chain — an explicit cap;
//   - `.in(...)` — an id list, which is what chunkedPaginated() and every
//     batched read use, and whose size is set by the caller;
//   - a filter whose VALUE references a parameter of an enclosing function —
//     `.eq("meeting_id", meetingId)` is one meeting's transcript, not a table.
//
// `user_id` is explicitly NOT a bound. Every read in this layer carries it and
// it is precisely the filter that grows with the account.
//
// ALLOWLIST, not a warning: some of these sweeps are correct and load-bearing
// (getContactsSearchCorpus is deliberately the whole network — see CAR-222).
// The point is that adding a new one costs a deliberate line here with a reason
// beside it, and that a sweep someone fixes must leave the list. Blind spots,
// stated: a bound carried by a LOCAL derived from a parameter reads as
// unbounded (findOrCreateSchool's ilike probe), and a filter built one
// statement earlier is invisible. Both fail toward over-inclusion, which costs
// an allowlist line; the other direction costs a live regression.

const SWEEP_ROOTS = (r) =>
  (r.startsWith("src/lib/data/") || r === "src/lib/company-queries.ts") &&
  // Defines paginateAll/chunkedPaginated; its own internal delegation is the
  // helper, not a read.
  r !== "src/lib/data/postgrest.ts";

/** PostgREST filter methods whose second argument can carry a caller's bound. */
const BOUNDING_FILTER = /^(eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|match|textSearch)$/;

/** The tenant key, which bounds nothing: every row in the account matches it. */
const TENANT_COLUMN = /(^|\.)user_id$/;

/**
 * Parameter names of every function-like scope enclosing `node`.
 *
 * `from` and `to` are excluded: they are the page window paginateAll hands its
 * callback, not anything a caller chose, and treating them as a bound would
 * make `.gte("date", from)` read as narrowed by the offset it is paging with.
 * This check fails toward over-inclusion everywhere else, and that has to hold
 * here too.
 */
const PAGE_WINDOW_PARAMS = new Set(["from", "to"]);

function enclosingParamNames(node) {
  const names = new Set();
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) {
      for (const p of cur.parameters) {
        for (const n of bindingNames(p.name)) if (!PAGE_WINDOW_PARAMS.has(n)) names.add(n);
      }
    }
  }
  return names;
}

/** The nearest named function around `node`, for a label that survives line moves. */
function enclosingFunctionName(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      ts.isVariableDeclaration(cur) &&
      cur.name &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      isFunctionLike(cur.initializer)
    ) {
      return cur.name.text;
    }
  }
  return "<anonymous>";
}

/** The callee's plain name, seeing through `ns.fn(...)` and `fn<T>(...)`. */
function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * True when some filter inside `call` narrows the read by something the CALLER
 * chose, rather than by the tenant it already belongs to.
 */
function hasCallerBound(call, sf) {
  const params = enclosingParamNames(call);
  let bounded = false;
  const visit = (n) => {
    if (bounded) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if (method === "limit") {
        bounded = true;
        return;
      }
      if (BOUNDING_FILTER.test(method) && n.arguments.length >= 2) {
        const [col, value] = n.arguments;
        const column = col && ts.isStringLiteral(col) ? col.text : "";
        if (!TENANT_COLUMN.test(column)) {
          // `.in()` is an id list; its length is the caller's, wherever the
          // list was assembled. Everything else has to name a parameter.
          if (method === "in") {
            bounded = true;
            return;
          }
          const text = value ? value.getText(sf) : "";
          for (const p of params) {
            if (new RegExp(`\\b${p}\\b`).test(text)) {
              bounded = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(call);
  return bounded;
}

const EXHAUSTIVE_SWEEP_ALLOWLIST = {
  // The targets view composes company-wide and per-office scope rows, and a
  // company is a target if ANY of its scopes is: there is no id list to narrow
  // by until this read has produced one.
  //
  // company_network_counts is an aggregate function, and its response is capped
  // at max_rows like any other. The `all` scope legitimately returns ~4,700
  // companies on the reference account, so exhaustion IS the answer here; the
  // ordinary scopes fit in a single page (CAR-229).
  "src/lib/company-queries.ts": [
    "fetchCompanyCounts:rpc:company_network_counts",
    "getCompanies:target_companies",
  ],
  // The pending set is shared by the web action list and MCP's listActionItems,
  // both of which narrow in memory; completed items are the full history.
  "src/lib/data/action-items.ts": [
    "getActionItems:follow_up_action_items",
    "getCompletedActionItems:follow_up_action_items",
  ],
  // Lookup map for calendar-attendee matching (address → contact), and the
  // search corpus, which is the WHOLE network on purpose (CAR-222: 9 active vs
  // ~1,996 other, so a tier-scoped search finds nobody). The schools probe is
  // narrowed by an ilike on a local derived from the caller's name.
  "src/lib/data/contacts.ts": [
    "getContactEmailLookup:contact_emails",
    "getContactsSearchCorpus:contacts",
    "probe:schools",
  ],
  // The three relationship-rule populations. Capping any one of them would pair
  // a whole-network on-track ratio with a truncated neglected list.
  "src/lib/data/follow-ups.ts": [
    "getDueFollowUps:contacts",
    "getContactsWithLastTouch:contacts",
    "getRelationshipsOnTrack:contacts",
  ],
  // The dashboard: the action list plus the active network, then the cosmetic
  // activity widgets, whose reads are bounded by a lookback WINDOW rather than
  // by a caller — a window bounds the time span, not the row count.
  //
  // fetchActivityRows lists two of its three sibling reads, which looks
  // arbitrary and is not: the third filters on `since` directly, a parameter,
  // while these two filter on `sinceDay`, a local derived from it one line
  // earlier. That is the "local derived from a parameter" blind spot named
  // above, sitting inside one function so it is easy to see. Over-inclusion,
  // which is the direction this check is built to fail in.
  "src/lib/data/home.ts": [
    "getHomeCoreData:follow_up_action_items",
    "getHomeCoreData:contacts",
    "fetchActivityRows:meetings",
    "fetchActivityRows:interactions",
    "getActivityHeatmap:email_messages",
    "getActivityHeatmap:contacts",
  ],
};

{
  const rows = [];
  const scanned = new Set();
  for (const file of walk("src/lib", [])) {
    const r = rel(file);
    if (isTestFile(r) || !SWEEP_ROOTS(r)) continue;
    scanned.add(r);
    const sf = parse(file);

    for (const node of collect(sf)) {
      if (!ts.isCallExpression(node) || calleeName(node) !== "paginateAll") continue;
      if (hasCallerBound(node, sf)) continue;
      // The table is the label's other half; a function with two sweeps is
      // otherwise two identical entries with nothing to tell them apart. An
      // .rpc() is labelled by the function it calls: a set-returning function's
      // response is capped at max_rows exactly like a table read, so paging one
      // to exhaustion is the same cost with a different name.
      const text = node.getText(sf);
      const fromTable = text.match(/\.from\(\s*["']([^"']+)["']/)?.[1];
      const rpcName = text.match(/\.rpc\(\s*["']([^"']+)["']/)?.[1];
      const table = fromTable ?? (rpcName ? `rpc:${rpcName}` : "<unknown>");
      rows.push({
        file: r,
        name: `${enclosingFunctionName(node)}:${table}`,
        line: lineOf(sf, node),
      });
    }
  }

  report(
    "exhaustive pagination without a caller-supplied bound",
    diffNamedRatchet(byFile(rows), EXHAUSTIVE_SWEEP_ALLOWLIST, scanned, BASELINE_HOME),
    "This read pages the table to exhaustion, so its cost is the size of the\n" +
      "  account rather than the size of the answer. On a 2,005-contact account\n" +
      "  that is three PostgREST round trips before the handler starts, and no\n" +
      "  test at a seeded scale can see it — a sweep and a keyed read are the\n" +
      "  same one request until the account passes 1,000 rows.\n" +
      "  Narrow it: an .in() over ids the caller already has\n" +
      "  (chunkedPaginated from src/lib/data/postgrest.ts), a filter on one of\n" +
      "  this function's parameters, or a deliberate .limit(). If the whole\n" +
      "  sweep really is the answer, add it to EXHAUSTIVE_SWEEP_ALLOWLIST with a\n" +
      "  comment saying why — and delete the entry when it stops sweeping.",
  );
}

// ── (o) range pagination without a stable order ──────────────────────────
//
// `.range()` is OFFSET/LIMIT. Postgres guarantees no ordering without an ORDER
// BY, so consecutive windows over an unordered query can return the same row
// twice and skip another entirely — a silent, data-dependent wrong answer that
// no test with fewer than pageSize rows can reproduce. src/lib/data/postgrest.ts
// states the contract in paginateAll's and chunkedPaginated's docblocks; until
// now nothing enforced it, and CAR-229 found a live instance in
// company-queries' employment sweep.
//
// A FREEZE AT ZERO, and with no escape hatch on purpose: all 72 range chains in
// src/ carry an order today, and there is no case where the fix is not simply
// `.order("id")`. A hatch here would only ever be used to write down a reason
// that is wrong.
//
// Anchored on the `.range()` call rather than on paginateAll(), which is
// strictly wider: it also covers hand-rolled `for (let from = 0; ...)` loops
// (storage-sweep.ts, contacts.ts) and the two shapes where the query is held in
// a variable (`let q = ...; await q.range(...)`), neither of which is reachable
// from the paginateAll call site.

/** The full property/call chain `node` sits in, walking back to its root. */
function chainRootOf(node) {
  let cur = node;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

{
  const violations = [];
  const files = [...walk("src/lib", []), ...walk("src/app", []), ...walk("src/mcp", [])];
  for (const file of files) {
    const r = rel(file);
    if (isTestFile(r)) continue;
    const sf = parse(file);
    const all = collect(sf);

    // Every text a query held in `name` could have been built from, so a
    // `.order()` applied where the variable was declared or reassigned still
    // counts. Cheap and file-local; a query assembled across modules is a
    // blind spot this does not claim to cover.
    const assignmentsOf = (name) => {
      const parts = [];
      for (const n of all) {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
          parts.push(n.initializer.getText(sf));
        }
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          n.left.text === name
        ) {
          parts.push(n.right.getText(sf));
        }
      }
      return parts.join("\n");
    };

    for (const node of all) {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) continue;
      if (node.expression.name.text !== "range") continue;

      let text = node.getText(sf);
      const root = chainRootOf(node);
      if (ts.isIdentifier(root)) text += "\n" + assignmentsOf(root.text);

      // Only PostgREST chains. `.range()` on anything else (a Range object, a
      // date helper) is not this rule's business.
      if (!/\.(from|select|rpc)\s*\(/.test(text)) continue;
      if (/\.order\s*\(/.test(text)) continue;

      violations.push(`${r}:${lineOf(sf, node)}: ${oneLine(node.getText(sf))}`);
    }
  }

  report(
    "range pagination without a stable .order()",
    violations,
    "`.range()` is OFFSET/LIMIT, and Postgres orders nothing without an ORDER BY,\n" +
      "  so successive windows over this query can return one row twice and drop\n" +
      "  another — silently, and only on accounts big enough to page. Add a stable\n" +
      "  tiebreak: .order(\"id\") is always sufficient, and goes AFTER any display\n" +
      "  ordering. See the paginateAll docblock in src/lib/data/postgrest.ts.",
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
    // The post-exclusion count, not CLIENT_FILES.length. The sentence says
    // "minus the API routes AND server files" but CLIENT_FILES only subtracts
    // the API routes — the server-file skip happens per check — so printing the
    // raw length overstated the inspected tree by the server files under
    // src/app. A specific claim nothing verifies is the thing the note above
    // warns about.
    `  client tree (${CLIENT_ROOTS.join(" + ")} minus the API routes and server files,\n` +
    `  ${CLIENT_FILES.filter((f) => !isServerFile(parse(f), f)).length} files) free of raw fetch( and native confirm(), as are the\n` +
    `  ${BROWSER_REACHABLE.size} modules outside it the browser still loads; plus no first-party\n` +
    "  /api fetch anywhere else under src/; double-submit and useLatestRequest\n" +
    `  ratchets at ${countBaseline(DOUBLE_SUBMIT_BASELINE)}/${countBaseline(LATEST_REQUEST_BASELINE)} known sites — each can only shrink;\n` +
    `  ${countBaseline(UNBOUNDED_READ_BASELINE)} unbounded multi-row reads inventoried across ${Object.keys(UNBOUNDED_READ_BASELINE).length} files, same ratchet;\n` +
    // The allowlist size is the claim, not "no sweeps exist" — these ARE
    // sweeps, deliberately, and the guard's value is that a new one cannot
    // appear without a line and a reason.
    `  ${countBaseline(EXHAUSTIVE_SWEEP_ALLOWLIST)} exhaustive data-layer sweeps allowlisted across ${Object.keys(EXHAUSTIVE_SWEEP_ALLOWLIST).length} files;\n` +
    "  every .range() window in src/{lib,app,mcp} carries a stable .order().",
);

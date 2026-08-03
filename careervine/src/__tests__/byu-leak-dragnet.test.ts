/**
 * The BYU leak dragnet (CAR-213, plan §8.1).
 *
 * ONE test over the whole app surface, not twenty per-component checks. The
 * point is to catch the places NOBODY REMEMBERED TO LIST — which is the actual
 * failure mode here. The first pass of this ticket hand-enumerated the badge
 * sites and missed three: the persona chip two lines above each badge, the
 * second bundle-subscribe screen in Settings, and both AI system prompts. A
 * per-component suite would have missed them by construction, because it can
 * only assert about files someone thought of.
 *
 * WHAT THIS CANNOT DO: it greps source text, so it catches hardcoded strings,
 * not wrong behaviour. A badge that renders for the wrong CONTACT says nothing
 * about BYU and sails straight through. bundle-sync-affinity-filter.test.ts
 * and school-affinity.test.ts are what cover that.
 *
 * THE ALLOWLIST IS THE INTERESTING PART. Every entry is a place where naming
 * BYU is correct, and each carries the reason. Adding a file here is a product
 * decision; if you find yourself adding one to make a build green, that is the
 * signal you have introduced the bug this file exists to catch.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const BYU = /\bbyu\b|brigham\s+young|cougar/i;

/**
 * Comments are stripped before scanning. The claim this file makes is about
 * what SHIPS — rendered copy, prompts, labels — and a comment explaining why
 * the BYU rule exists is not a leak, it is documentation. Scanning them would
 * force an allowlist so long that a real leak could hide inside it.
 *
 * The `://` guard keeps URLs inside string literals intact; erring toward
 * keeping code is the safe direction, since a false positive costs an
 * allowlist entry and a false negative costs the whole point of the file.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i === -1) return line;
      if (i > 0 && line[i - 1] === ":") return line;
      return line.slice(0, i);
    })
    .join("\n");
}

/**
 * Files permitted to name BYU, each with the reason it is correct there.
 * Paths are relative to src/.
 */
const ALLOWED: Record<string, string> = {
  // The rule itself has to name the thing it matches.
  "lib/schools/affinity.ts": "the BYU-family rule is defined here",
  "lib/schools/affinity-fixtures.ts": "fixture inputs and near-miss traps for that rule",
  "lib/schools/university-list.ts": "the curated list contains the BYU campuses",

  // Copy that is TRUE for the audience that sees it. The non-affinity
  // disclosure names the database's real provenance, which is the honest thing
  // to say to someone asking why their count is smaller.
  "components/onboarding/onboarding-flow.tsx":
    "the non-affinity disclosure states the bundle's real BYU provenance",

  // verified_school's CHECK vocabulary is literally these four string values,
  // so the mapper cannot avoid naming them.
  "lib/scrape-mapper.ts": "verified_school's CHECK vocabulary is these exact values",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "__integration__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Shipping DOC surfaces, which live outside src/ and were therefore invisible
 * to the walk above. That blind spot is not hypothetical: it let an example
 * prompt in careervine-mcp/README.md ("draft her a short intro email
 * mentioning my BYU background") survive the entire Phase 7 copy sweep, and it
 * only surfaced because Dawson questioned a different finding.
 *
 * These three make claims to users and must be checked with the same rule.
 * Comments do not exist in HTML/Markdown prose the way they do in TS, so these
 * are scanned raw.
 */
const DOC_SURFACES = [
  "../public/docs/index.html",
  "../../README.md",
  "../../careervine-mcp/README.md",
];

describe("no BYU string reaches a non-affinity user in shipped docs", () => {
  it("finds none in the docs page, README, or MCP README", () => {
    const offenders = DOC_SURFACES.map((rel) => ({
      file: rel,
      hit: BYU.test(readFileSync(join(SRC, rel), "utf8")),
    }))
      .filter((d) => d.hit)
      .map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  it("actually reads those files — the positive control", () => {
    // A typo'd path would throw, not pass silently; assert content instead so
    // a file that becomes empty also fails.
    for (const rel of DOC_SURFACES) {
      expect(readFileSync(join(SRC, rel), "utf8").length).toBeGreaterThan(500);
    }
  });
});

describe("no BYU string reaches a non-affinity user", () => {
  const offenders = walk(SRC)
    .map((f) => ({ file: relative(SRC, f), text: stripComments(readFileSync(f, "utf8")) }))
    .filter(({ text }) => BYU.test(text))
    .map(({ file }) => file)
    .filter((file) => !(file in ALLOWED))
    .sort();

  it("finds no unallowlisted BYU reference anywhere under src/", () => {
    expect(offenders).toEqual([]);
  });

  it("actually inspects files — the positive control", () => {
    // Without this, a walk() that returned nothing (wrong path, changed
    // layout, a bad extension filter) would make the assertion above pass
    // against an empty set forever. This is the exact vacuous-pass shape the
    // dragnet is supposed to defeat, so it gets its own guard.
    const all = walk(SRC);
    expect(all.length).toBeGreaterThan(300);
    expect(all.some((f) => f.endsWith("lib/schools/affinity.ts"))).toBe(true);

    const matching = all.filter((f) => BYU.test(stripComments(readFileSync(f, "utf8"))));
    expect(matching.length).toBeGreaterThan(2);
  });

  it("every allowlist entry still exists and still names BYU", () => {
    // A stale allowlist silently grants permission to a file that no longer
    // needs it, and hides the next real leak in that path.
    const missing: string[] = [];
    const noLongerMatching: string[] = [];
    for (const rel of Object.keys(ALLOWED)) {
      try {
        if (!BYU.test(stripComments(readFileSync(join(SRC, rel), "utf8")))) noLongerMatching.push(rel);
      } catch {
        missing.push(rel);
      }
    }
    expect({ missing, noLongerMatching }).toEqual({ missing: [], noLongerMatching: [] });
  });

  it("every allowlist entry carries a non-empty reason", () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, why]) => !why.trim())
      .map(([f]) => f);
    expect(unexplained).toEqual([]);
  });
});

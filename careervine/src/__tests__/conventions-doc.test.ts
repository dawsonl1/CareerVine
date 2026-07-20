/**
 * Keeps careervine/CONVENTIONS.md honest (CAR-157, F16/F17).
 *
 * The doc it guards replaced ARCHITECTURE.md, which rotted into a majority-false
 * map of the codebase because nothing ever checked it. Four layers of guard:
 *
 *   1. Every repo-root-relative path the doc cites must exist on disk — a rename
 *      turns the doc red instead of quietly stale.
 *   2. Citations must BE repo-root-relative: a `src/...` span is invisible to
 *      layer 1 (the allowlist filter drops it), so the convention is enforced
 *      rather than assumed.
 *   3. Every symbol the doc names is asserted to exist in the file the doc
 *      points at — a symbol rename is likelier than a file move.
 *   4. The doc's counted claims (routes, wrapper adoption, schedules, capability
 *      keys) are recomputed from the codebase and matched against the prose —
 *      the root README's route count rotted 61 → 105 before CAR-157 removed it,
 *      and an unpinned count here would rot the same way.
 *
 * This still proves pointers and counts, not prose truth in general.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
// Import-safe: the registry's CLI only runs when executed directly.
import { SCHEDULES } from "../../scripts/qstash-schedules.mjs";

// Resolved from this file, not process.cwd(), so the test is invocation-independent
// (CI runs vitest from careervine/, a local run may not).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DOC_PATH = path.join(REPO_ROOT, "careervine", "CONVENTIONS.md");

/**
 * Top-level directories a repo-relative citation may start with. An allowlist
 * rather than a general path regex, so backticked prose like `admin/` (a route
 * prefix) or `{ success: true }` is never mistaken for a file to resolve.
 */
const TOP_LEVEL = [
  "careervine",
  "careervine-mcp",
  "chrome-extension",
  "supabase",
  "scripts",
  "docs",
  "pipelines",
  "research",
  "ai-instruction",
  "\\.claude",
  "\\.github",
];

const CITATION = new RegExp(`^(?:${TOP_LEVEL.join("|")})/[^\\s*]+$`);

function backtickSpans(markdown: string): string[] {
  return (markdown.match(/`[^`\n]+`/g) ?? []).map((s) => s.slice(1, -1).trim());
}

function citedPaths(markdown: string): string[] {
  const found = backtickSpans(markdown)
    .filter((s) => CITATION.test(s))
    // Tolerate a trailing :line or :line-line hint, and a trailing slash on dirs.
    .map((s) => s.replace(/:\d+(?:-\d+)?$/, "").replace(/\/$/, ""));
  return [...new Set(found)];
}

/**
 * Symbols the doc names, each asserted to exist (word-bounded) in the file the
 * doc's prose associates it with. Closes the false-green where a cited file
 * survives a rename of the symbol inside it.
 */
const SYMBOL_CLAIMS: Array<[file: string, symbols: string[]]> = [
  ["careervine/src/lib/api-handler.ts", ["withApiHandler", "ApiError", "requireCapability", "InferApiResponse"]],
  ["careervine/src/lib/api-client.ts", ["apiFetch", "apiSend", "ApiRequestError"]],
  ["careervine/src/lib/qstash-verify.ts", ["withQStashVerification"]],
  ["careervine/src/lib/cron-guard.ts", ["withCronGuard"]],
  ["careervine/src/lib/capabilities/map.ts", ["capabilitiesFor"]],
  ["careervine/src/lib/capabilities/resolve.ts", ["resolveCapabilities"]],
  ["careervine/src/hooks/use-capabilities.ts", ["useCapabilities"]],
  ["careervine/src/components/capable.tsx", ["Capable"]],
  ["careervine/src/lib/data/client.ts", ["db", "setDataClient", "must"]],
  ["careervine/src/lib/rules/network-status.ts", ["isActiveContact"]],
  ["careervine/src/lib/rules/neglected.ts", ["deriveNeglectedContacts"]],
  ["careervine/src/lib/notify/email.ts", ["sendAppEmail"]],
  ["careervine/src/lib/email-send.ts", ["sendTrackedEmail", "SendPolicyError"]],
  ["careervine/src/lib/ui-events.ts", ["emitUiEvent", "onUiEvent"]],
  ["careervine/src/hooks/use-latest-request.ts", ["useLatestRequest", "begin", "isLatest"]],
  ["careervine/src/__tests__/route-auth-inventory.test.ts", ["HAND_ROLLED"]],
  ["careervine/src/lib/admin-auth.ts", ["isAuthorizedAdminToken"]],
  ["careervine/src/components/compose-email-modal.tsx", ["submittingRef"]],
  ["careervine/src/components/contacts/contact-edit-modal.tsx", ["savingRef"]],
];

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
];

describe("CONVENTIONS.md", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const paths = citedPaths(markdown);

  it("cites a meaningful number of paths", () => {
    // Guards against a regex or allowlist change silently shrinking coverage,
    // which would make the per-path assertions vacuously narrow. Actual count at
    // time of writing: 39. Keep the floor snug — a large gap here tolerates
    // silent citation loss.
    expect(paths.length).toBeGreaterThanOrEqual(35);
  });

  it.each(paths)("cited path exists: %s", (rel) => {
    expect(existsSync(path.join(REPO_ROOT, rel))).toBe(true);
  });

  it("cites paths repo-root-relative, never careervine-relative", () => {
    // A `src/...` span is invisible to the existence check above (the allowlist
    // drops it), so it would be an UNGUARDED citation — the exact quiet-rot
    // failure this file exists to prevent.
    const careervineRelative = backtickSpans(markdown).filter((s) => /^(src|public|scripts)\/[^\s]*$/.test(s));
    expect(
      careervineRelative,
      `citations must start at the repo root (prefix with careervine/): ${careervineRelative.join(", ")}`,
    ).toEqual([]);
  });

  it.each(SYMBOL_CLAIMS)("symbols the doc names exist in %s", (file, symbols) => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const symbol of symbols) {
      expect(
        new RegExp(`\\b${symbol}\\b`).test(text),
        `${file} no longer contains "${symbol}" — update CONVENTIONS.md (and this map) to match the rename`,
      ).toBe(true);
    }
  });

  it("does not cite the map it replaced", () => {
    // ARCHITECTURE.md was deleted by CAR-157. A citation of it would mean the
    // comprehensive-map anti-pattern crept back in.
    expect(existsSync(path.join(REPO_ROOT, "careervine", "ARCHITECTURE.md"))).toBe(false);
  });

  it("covers the API route convention", () => {
    // Exit criterion: `rg withApiHandler --glob '*.md'` must hit this doc.
    expect(markdown).toContain("withApiHandler");
  });

  describe("counted claims match the codebase", () => {
    const apiDir = path.join(REPO_ROOT, "careervine", "src", "app", "api");
    const routeFiles = fg.sync("**/route.{ts,tsx,js,jsx,mjs}", { cwd: apiDir, dot: true });
    const total = routeFiles.length;
    const wrapped = routeFiles.filter((f) =>
      /\bwithApiHandler\s*[<(]/.test(readFileSync(path.join(apiDir, f), "utf8")),
    ).length;
    const skip = total - wrapped;

    it("route census (a route count rotted 61 → 105 in the old README)", () => {
      for (const needle of [
        `${total} routes live under`,
        `${wrapped} of them go through`,
        `The ${skip} routes that skip`,
        `The ${skip} routes that deliberately skip`,
      ]) {
        expect(markdown, `doc must say "${needle}" — the codebase moved; update the prose`).toContain(needle);
      }
    });

    it("schedule count", () => {
      expect(markdown).toContain(`${WORDS[SCHEDULES.length]} QStash schedules`);
    });

    it("capability key count", () => {
      const types = readFileSync(
        path.join(REPO_ROOT, "careervine", "src", "lib", "capabilities", "types.ts"),
        "utf8",
      );
      // One `| "key"` per line; counting line-anchored members survives inline
      // comments (one of which contains a semicolon that broke a slice approach).
      const keys = (types.match(/^\s*\|\s*"[^"]+"/gm) ?? []).length;
      expect(keys).toBeGreaterThan(0);
      expect(markdown).toContain(`${WORDS[keys]} keys exist today`);
    });
  });
});

/**
 * Keeps careervine/CONVENTIONS.md honest (CAR-157, F16/F17).
 *
 * The doc it guards replaced ARCHITECTURE.md, which rotted into a majority-false
 * map of the codebase because nothing ever checked it. A conventions doc is only
 * useful if its pointers resolve, so every repo-relative path the doc cites is
 * asserted to exist here: rename a cited file without updating the doc and CI
 * goes red instead of the doc going quietly wrong.
 *
 * Scope note: this proves the pointers resolve, not that the prose is true. The
 * doc deliberately cites files and symbols rather than line numbers, since line
 * numbers rot silently and cannot be checked this cheaply.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function citedPaths(markdown: string): string[] {
  const spans = markdown.match(/`[^`\n]+`/g) ?? [];
  const found = spans
    .map((s) => s.slice(1, -1).trim())
    .filter((s) => CITATION.test(s))
    // Tolerate a trailing :line or :line-line hint, and a trailing slash on dirs.
    .map((s) => s.replace(/:\d+(?:-\d+)?$/, "").replace(/\/$/, ""));
  return [...new Set(found)];
}

describe("CONVENTIONS.md", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const paths = citedPaths(markdown);

  it("cites a meaningful number of paths", () => {
    // Guards against a regex change silently matching nothing, which would make
    // every assertion below vacuously pass.
    expect(paths.length).toBeGreaterThanOrEqual(20);
  });

  it.each(paths)("cited path exists: %s", (rel) => {
    expect(existsSync(path.join(REPO_ROOT, rel))).toBe(true);
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
});

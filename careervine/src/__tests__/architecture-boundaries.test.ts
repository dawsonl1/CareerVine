/**
 * CAR-140 (F55 / F25): import-direction invariants.
 *
 *  1. src/lib points strictly downward — nothing under src/lib may import from
 *     @/components (that would invert the dependency and, in the analytics case,
 *     form a lib↔components cycle).
 *  2. No API route imports auth (or anything else) from a sibling route module.
 *     Shared auth lives in src/lib/admin-auth, not exported out of a route file.
 *
 * Pure string scan over source text — fast, no module execution. The patterns
 * match both `@/`-alias and relative-path specifiers, and both static `from` and
 * dynamic `import(...)` forms, so a relative or dynamic import can't evade the rule.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const libDir = path.join(srcDir, "lib");
const apiDir = path.join(srcDir, "app/api");

// `from "X"` (static) or `import("X")` (dynamic), left side only — the specifier X is matched next.
const IMPORT_OF = "(?:from\\s+|import\\s*\\(\\s*)";

// Imports a component: `@/components/…` or a relative `../…/components/…`.
const IMPORTS_COMPONENT = new RegExp(`${IMPORT_OF}["'](?:@/components|(?:\\.\\.?/)+[^"']*?components)[/"']`);

// Imports another route module: specifier under `@/app/api/…` or relative `./…`/`../…`, ending in `/route`.
const IMPORTS_SIBLING_ROUTE = new RegExp(`${IMPORT_OF}["'](?:@/app/api/|\\.\\.?/)[^"']*/route["']`);

describe("architecture boundaries", () => {
  it("nothing under src/lib imports a component (alias, relative, or dynamic)", () => {
    const libFiles = fg.sync("**/*.{ts,tsx}", { cwd: libDir, absolute: true });
    expect(libFiles.length).toBeGreaterThan(0);
    const offenders = libFiles.filter((f) => IMPORTS_COMPONENT.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      "src/lib must point downward — move the component or pass data as props",
    ).toEqual([]);
  });

  it("no API route imports from a sibling route module (alias, relative, or dynamic)", () => {
    // dot: true so a route inside a dot-directory can't dodge the boundary check
    // (found via CAR-157's review — the sibling inventory had the same blindness).
    const routeFiles = fg.sync("**/route.{ts,tsx,js,jsx,mjs}", { cwd: apiDir, absolute: true, dot: true });
    expect(routeFiles.length).toBeGreaterThan(50);
    const offenders = routeFiles.filter((f) => IMPORTS_SIBLING_ROUTE.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      "route files must not import from another route — put shared code in src/lib",
    ).toEqual([]);
  });
});

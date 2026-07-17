/**
 * CAR-140 (F55 / F25): import-direction invariants.
 *
 *  1. src/lib points strictly downward — nothing under src/lib may import from
 *     @/components (that would invert the dependency and, in the analytics case,
 *     form a lib↔components cycle).
 *  2. No API route imports auth (or anything else) from a sibling route module.
 *     Shared auth lives in src/lib/admin-auth, not exported out of a route file.
 *
 * Pure string scan over source text — fast, no module execution.
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

describe("architecture boundaries", () => {
  it("nothing under src/lib imports from @/components", () => {
    const libFiles = fg.sync("**/*.{ts,tsx}", { cwd: libDir, absolute: true });
    expect(libFiles.length).toBeGreaterThan(0);
    const offenders = libFiles.filter((f) => /from\s+["']@\/components/.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      "src/lib must point downward — move the component or pass data as props",
    ).toEqual([]);
  });

  it("no API route imports from a sibling route module", () => {
    const routeFiles = fg.sync("**/route.ts", { cwd: apiDir, absolute: true });
    expect(routeFiles.length).toBeGreaterThan(50);
    const offenders = routeFiles.filter((f) =>
      /from\s+["']@\/app\/api\/[^"']*\/route["']/.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      "route files must not import from another route — put shared code in src/lib",
    ).toEqual([]);
  });
});

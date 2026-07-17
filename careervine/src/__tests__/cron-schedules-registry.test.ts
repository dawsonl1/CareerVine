/**
 * CAR-140 (R3.5 / F12): the QStash schedule registry in
 * scripts/qstash-schedules.mjs must stay in lock-step with the actual cron
 * routes. Every `src/app/api/cron/<name>/route.ts` must have a SCHEDULES entry,
 * and every SCHEDULES entry must point at a real cron route. Adding a bare cron
 * route without registering it — or deleting a route while leaving its schedule
 * declared — turns this test red, so an unregistered cron can never ship silently.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
// Import the authoritative array straight from the deploy script (import-safe:
// the script's CLI only runs when executed directly, never on import).
import { SCHEDULES } from "../../scripts/qstash-schedules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cronDir = path.resolve(here, "../app/api/cron");

/** Directory names under src/app/api/cron that actually contain a route.ts. */
function cronRouteDirs(): string[] {
  return readdirSync(cronDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return readdirSync(path.join(cronDir, e.name)).includes("route.ts");
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort();
}

describe("QStash cron schedule registry", () => {
  const routeDirs = cronRouteDirs();
  const declaredPaths = new Set(SCHEDULES.map((s: { path: string }) => s.path));
  const declaredNames = new Set(SCHEDULES.map((s: { name: string }) => s.name));

  it("finds cron routes on disk (guards against a broken glob)", () => {
    expect(routeDirs.length).toBeGreaterThan(0);
  });

  it("registers every cron route in SCHEDULES", () => {
    const unregistered = routeDirs.filter((dir) => !declaredPaths.has(`/api/cron/${dir}`));
    expect(unregistered, `cron routes missing a SCHEDULES entry: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("has no SCHEDULES entry pointing at a non-existent cron route", () => {
    const routeDirSet = new Set(routeDirs);
    const orphans = SCHEDULES.filter(
      (s: { path: string }) => s.path.startsWith("/api/cron/") && !routeDirSet.has(s.path.replace("/api/cron/", "")),
    ).map((s: { name: string }) => s.name);
    expect(orphans, `SCHEDULES entries with no matching cron route: ${orphans.join(", ")}`).toEqual([]);
  });

  it("keeps each schedule's name aligned with its route path", () => {
    for (const s of SCHEDULES as Array<{ name: string; path: string }>) {
      if (s.path.startsWith("/api/cron/")) {
        expect(s.path, `schedule "${s.name}" path/name mismatch`).toBe(`/api/cron/${s.name}`);
      }
    }
    // Sanity: names are unique.
    expect(declaredNames.size).toBe(SCHEDULES.length);
  });
});

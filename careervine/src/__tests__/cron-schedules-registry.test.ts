/**
 * CAR-140 (R3.5 / F12): the QStash schedule registry in
 * scripts/qstash-schedules.mjs must stay in lock-step with the actual cron
 * routes. Every `src/app/api/cron/<name>/route.ts` must have a SCHEDULES entry,
 * and every SCHEDULES entry must point at a real cron route. Adding a bare cron
 * route without registering it — or deleting a route while leaving its schedule
 * declared — turns this test red, so an unregistered cron can never ship silently.
 */

import { readdirSync, readFileSync } from "node:fs";
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

/**
 * CAR-157 (F41): the tests above prove every cron route is *registered*, but
 * pinned nothing about *when* it runs, so a cadence could be changed without
 * anything going red. That is exactly how the docs page, the app README, and the
 * send-follow-ups route header all came to claim "every 15 minutes" for a job
 * that runs every 10.
 *
 * Two guards, both anchored to the registry as the single source of truth:
 * the cron expressions themselves are pinned, and the user-facing copy that
 * quotes a cadence is asserted to match what the registry actually declares.
 */
describe("QStash cadence is pinned to the registry", () => {
  const EXPECTED_CRONS: Record<string, string> = {
    "send-follow-ups": "*/10 * * * *",
    "send-scheduled-emails": "*/15 * * * *",
    "sync-bundles": "0 12 * * *",
    "scrape-refresh": "0 9 * * *",
    discovery: "0 10 * * 1",
    "storage-sweep": "0 10 * * *",
    "data-retention": "30 10 * * *",
    "follow-up-nudges": "0 15 * * *",
  };

  it("pins every declared cron expression", () => {
    const actual = Object.fromEntries(
      (SCHEDULES as Array<{ name: string; cron: string }>).map((s) => [s.name, s.cron]),
    );
    // Changing a cadence is fine, but it must be deliberate: update this map and
    // the copy assertions below in the same change.
    expect(actual).toEqual(EXPECTED_CRONS);
  });

  /** Minutes from an every-N-minutes interval cron, else null. */
  function intervalMinutes(cron: string): number | null {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
    return m ? Number(m[1]) : null;
  }

  /**
   * Both interval schedules are quoted in user-facing copy, so both are pinned.
   * Every needle is SUBJECT-ANCHORED — it names the job in the same phrase as the
   * interval — because a bare "every N minutes" fragment is satisfied by ANY
   * schedule that happens to share the interval: with presence-only fragments,
   * swapping the two README lines (mislabeling both jobs) stayed green, and so
   * did drifting one schedule onto the other's cadence. The tag needle keeps its
   * trailing "<" to pin the docs page's feature-card tag, easy to miss when
   * editing only the sentence next to it. The two route header comments are
   * pinned too — a stale header here is exactly how the F41 drift started.
   */
  const COPY_PINNED: Array<{
    schedule: string;
    readme: (m: number) => string[];
    docs: (m: number) => string[];
  }> = [
    {
      schedule: "send-follow-ups",
      readme: (m) => [`Follow-up sequence steps are processed every ${m} minutes`],
      docs: (m) => [`due follow-up steps go out every ${m} minutes`, `Every ${m} min<`],
    },
    {
      schedule: "send-scheduled-emails",
      readme: (m) => [`Scheduled emails are sent every ${m} minutes`],
      docs: (m) => [`scheduled emails every ${m} minutes`],
    },
  ];

  it.each(COPY_PINNED)(
    "keeps user-facing $schedule cadence copy in sync with the registry",
    ({ schedule, readme, docs }) => {
      const entry = (SCHEDULES as Array<{ name: string; cron: string }>).find((s) => s.name === schedule);
      expect(entry, `${schedule} missing from the registry`).toBeDefined();

      const minutes = intervalMinutes(entry!.cron);
      expect(minutes, `${schedule} cron is no longer a simple interval: ${entry!.cron}`).not.toBeNull();

      const repoRoot = path.resolve(here, "../../..");
      const surfaces: Array<{ file: string; needles: string[] }> = [
        { file: path.join(repoRoot, "careervine", "README.md"), needles: readme(minutes!) },
        {
          file: path.join(repoRoot, "careervine", "public", "docs", "index.html"),
          needles: docs(minutes!),
        },
        {
          // The route's own header comment states its cadence; pin it so the
          // comment cannot drift from the registry again.
          file: path.join(repoRoot, "careervine", "src", "app", "api", "cron", schedule, "route.ts"),
          needles: [`every ${minutes} minutes`],
        },
      ];

      for (const { file, needles } of surfaces) {
        const copy = readFileSync(file, "utf8");
        for (const needle of needles) {
          expect(
            copy,
            `${path.relative(repoRoot, file)} must state the ${schedule} cadence as "${needle}" to match ` +
              `scripts/qstash-schedules.mjs (${entry!.cron}). Update the copy, not this test.`,
          ).toContain(needle);
        }
      }
    },
  );
});

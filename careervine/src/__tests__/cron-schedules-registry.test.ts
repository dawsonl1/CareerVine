/**
 * CAR-140 (R3.5 / F12): the QStash schedule registry in
 * scripts/qstash-schedules.mjs must stay in lock-step with the actual cron
 * routes. Every `src/app/api/cron/<name>/route.ts` must have a SCHEDULES entry,
 * and every SCHEDULES entry must point at a real cron route. Adding a bare cron
 * route without registering it — or deleting a route while leaving its schedule
 * declared — turns this test red, so an unregistered cron can never ship silently.
 */

import fg from "fast-glob";
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

  /**
   * Cron routes that are deliberately NOT QStash-scheduled (CAR-234).
   *
   * These are driven by systemd timers on the A1 box (`ops/gmail-sync/`), because
   * their schedule is expressed in the user's LOCAL time and systemd 249 on that
   * box cannot put a timezone in `OnCalendar` — the full sweep ticks hourly and a
   * wrapper picks the Mountain hours, so DST cannot slide it. A QStash entry
   * would be a second, contradicting trigger for the same work.
   *
   * Named individually rather than pattern-matched: a new unregistered cron route
   * should still fail this test and force the author to say which mechanism owns
   * it, which is the whole point of the check.
   */
  const A1_DRIVEN_CRON_ROUTES = new Set(["sync-gmail-full", "sync-gmail-recent"]);

  it("registers every cron route in SCHEDULES, or names it as A1-driven", () => {
    const unregistered = routeDirs.filter(
      (dir) => !declaredPaths.has(`/api/cron/${dir}`) && !A1_DRIVEN_CRON_ROUTES.has(dir),
    );
    expect(unregistered, `cron routes missing a SCHEDULES entry: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("every A1-driven exemption still names a route that exists", () => {
    // Anti-vacuity: a stale exemption is worse than none, because it silently
    // excuses whatever route later takes that name.
    const stale = [...A1_DRIVEN_CRON_ROUTES].filter((dir) => !routeDirs.includes(dir));
    expect(stale, `A1-driven exemptions for routes that no longer exist: ${stale.join(", ")}`).toEqual([]);
    // And they must genuinely have no QStash entry, or the exemption is a lie.
    const alsoScheduled = [...A1_DRIVEN_CRON_ROUTES].filter((dir) => declaredPaths.has(`/api/cron/${dir}`));
    expect(alsoScheduled, `exempted as A1-driven but also QStash-scheduled: ${alsoScheduled.join(", ")}`).toEqual([]);
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
    "send-follow-ups": "0 * * * *",
    "send-scheduled-emails": "0 * * * *",
    "sync-bundles": "0 12 * * *",
    "scrape-refresh": "0 9 * * *",
    discovery: "0 10 * * 1",
    "storage-sweep": "0 10 * * *",
    "data-retention": "30 10 * * *",
    "follow-up-nudges": "0 15 * * *",
    "detect-bounces": "0 11 * * *",
  };

  it("pins every declared cron expression", () => {
    const actual = Object.fromEntries(
      (SCHEDULES as Array<{ name: string; cron: string }>).map((s) => [s.name, s.cron]),
    );
    // Changing a cadence is fine, but it must be deliberate: update this map and
    // the copy assertions below in the same change.
    expect(actual).toEqual(EXPECTED_CRONS);
  });

  /** True for an hourly-on-the-hour cron, which is what a safety net must be. */
  function isHourly(cron: string): boolean {
    return cron === "0 * * * *";
  }

  /**
   * Both send schedules are quoted in user-facing copy, so both are pinned.
   *
   * CAR-215 changed WHAT the copy has to say. These are no longer the primary
   * driver: the A1 send watcher triggers both routes within ~15s of anything
   * coming due, and QStash runs them hourly only as a safety net. So the copy
   * now makes a latency promise ("within a minute") rather than quoting a poll
   * interval, and the surfaces are pinned against BOTH halves: the promise must
   * be there, and the stale "every N minutes" phrasing must NOT be, or the docs
   * would keep advertising a 15-minute delay this change removed.
   *
   * Every needle stays SUBJECT-ANCHORED, naming the job in the same phrase as
   * the claim, because a bare fragment is satisfied by any schedule that
   * happens to share it: with presence-only fragments, swapping the two README
   * lines (mislabeling both jobs) stayed green. The tag needle keeps its
   * trailing "<" to pin the docs page's feature-card tag, easy to miss when
   * editing only the sentence next to it. The two route header comments are
   * pinned too: a stale header is exactly how the F41 drift started.
   */
  const COPY_PINNED: Array<{
    schedule: string;
    readme: string[];
    docs: string[];
    route: string[];
  }> = [
    {
      schedule: "send-follow-ups",
      readme: ["Follow-up sequence steps go out within about a minute"],
      docs: ["due follow-up steps go out within about a minute", "Within a minute<"],
      route: ["within ~15s of a step coming due", "QStash\n * hourly as a safety net"],
    },
    {
      schedule: "send-scheduled-emails",
      readme: ["Scheduled emails are sent within about a minute"],
      docs: ["scheduled emails within about a minute"],
      route: ["within ~15s of anything coming due", "QStash, hourly, as a safety net"],
    },
  ];

  /** Phrasings that would mean the old polling latency is still being advertised. */
  const STALE_CADENCE = [/every \d+ minutes/i, /Every \d+ min</];

  it.each(COPY_PINNED)(
    "keeps user-facing $schedule copy in sync with the registry",
    ({ schedule, readme, docs, route }) => {
      const entry = (SCHEDULES as Array<{ name: string; cron: string }>).find((s) => s.name === schedule);
      expect(entry, `${schedule} missing from the registry`).toBeDefined();
      expect(
        isHourly(entry!.cron),
        `${schedule} is no longer the hourly safety net (${entry!.cron}). If that is deliberate, ` +
          `the copy promise below has to change with it.`,
      ).toBe(true);

      const repoRoot = path.resolve(here, "../../..");
      const surfaces: Array<{ file: string; needles: string[] }> = [
        { file: path.join(repoRoot, "careervine", "README.md"), needles: readme },
        {
          file: path.join(repoRoot, "careervine", "public", "docs", "index.html"),
          needles: docs,
        },
        {
          file: path.join(repoRoot, "careervine", "src", "app", "api", "cron", schedule, "route.ts"),
          needles: route,
        },
      ];

      for (const { file, needles } of surfaces) {
        const copy = readFileSync(file, "utf8");
        for (const needle of needles) {
          expect(
            copy,
            `${path.relative(repoRoot, file)} must state the ${schedule} behaviour as "${needle}". ` +
              `Update the copy, not this test.`,
          ).toContain(needle);
        }
      }
    },
  );

  /**
   * CAR-220: this swept exactly two files while its commit message described it
   * as covering every surface. Two live toasts kept telling users a requeued
   * email would "send within 15 minutes" (it now goes in ~15 seconds), and five
   * code comments still called the cron "the sole send driver" — including the
   * retry route the CAR-215 plan had explicitly listed as copy that must move.
   *
   * A guard that names two paths cannot notice a third. So the sweep now walks
   * every user-facing component and API route rather than an allowlist, and a
   * new surface is covered the moment it exists.
   */
  it("no longer advertises a polling interval anywhere user-facing", async () => {
    const repoRoot = path.resolve(here, "../../..");
    const files = [
      path.join(repoRoot, "careervine", "README.md"),
      path.join(repoRoot, "careervine", "public", "docs", "index.html"),
      ...(await fg(["careervine/src/components/**/*.tsx", "careervine/src/app/api/**/*.ts"], {
        cwd: repoRoot,
        absolute: true,
        ignore: ["**/__tests__/**"],
      })),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const copy = readFileSync(file, "utf8");
      for (const pattern of STALE_CADENCE) {
        const hit = copy.match(pattern);
        if (hit) offenders.push(`${path.relative(repoRoot, file)}: "${hit[0]}"`);
      }
    }

    expect(
      offenders,
      "these still advertise a polling interval. Sends are driven by the A1 watcher " +
        "within seconds; QStash is only the hourly safety net.",
    ).toEqual([]);
  });

  it("no longer calls the cron the sole send driver", () => {
    // A second, separate claim: CAR-139 made the cron the only driver, CAR-215
    // made the watcher primary. Comments asserting the old arrangement send the
    // next reader looking in the wrong place.
    const repoRoot = path.resolve(here, "../../..");
    const hits = fg.sync(["careervine/src/**/*.ts", "careervine/src/**/*.tsx"], {
      cwd: repoRoot,
      absolute: true,
      ignore: ["**/__tests__/**", "**/node_modules/**"],
    }).filter((f) => /sole send driver/.test(readFileSync(f, "utf8")));

    expect(
      hits.map((f) => path.relative(repoRoot, f)),
      "the cron is no longer the sole send driver (CAR-215)",
    ).toEqual([]);
  });
});

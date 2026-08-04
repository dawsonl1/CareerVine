/**
 * `vercel.json` may not carry routing (rule 33, retired into this file).
 *
 * Vercel SILENTLY IGNORES `rewrites`, `redirects` and `headers` on Next.js
 * projects. The deploy succeeds, the key sits in the file looking authoritative,
 * and the routing rule simply does not exist. CAR-71's docs subdomain shipped
 * "green" exactly that way — build, tests, DNS and domain all passing while the
 * host served the wrong content — and the cause took a while to find precisely
 * because nothing anywhere disagreed with the config.
 *
 * Routing belongs in `careervine/next.config.ts`, whose `rewrites().beforeFiles`
 * is what actually serves the host-scoped rules (docs.careervine.app).
 *
 * This exists so the trap is caught where it happens rather than remembered: it
 * is the guard that let rule 33 move out of CLAUDE.md and into the archive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file rather than process.cwd(), so the test does not depend
// on where vitest was invoked from.
const VERCEL_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../vercel.json",
);

/**
 * Keys Vercel ignores on a Next.js project. Deliberately limited to the three
 * rule 33 was written after; adding a key here is a claim that Vercel ignores it
 * too, and that claim should be verified before it is made.
 */
const IGNORED_ON_NEXT = ["rewrites", "redirects", "headers"] as const;

describe("vercel.json", () => {
  const config = JSON.parse(readFileSync(VERCEL_JSON, "utf8")) as Record<string, unknown>;

  it("still configures something, so the absence checks below cannot pass vacuously", () => {
    // An emptied or relocated vercel.json satisfies every "does not define X"
    // assertion while proving nothing — the same vacuous-absence trap CAR-191
    // found in the E2E suite. Anchor on a key the file is actually here to set.
    expect(Object.keys(config).length).toBeGreaterThan(0);
    expect(config).toHaveProperty("regions");
  });

  it.each(IGNORED_ON_NEXT)("does not define %s", (key) => {
    expect(
      config[key],
      `vercel.json defines "${key}", which Vercel silently ignores on Next.js projects: ` +
        `the deploy succeeds and the rule never takes effect. Define it in ` +
        `careervine/next.config.ts instead (rewrites().beforeFiles for host-scoped rules), ` +
        `and re-verify the production URL after deploying.`,
    ).toBeUndefined();
  });
});

/**
 * CAR-140 (F31): .env.example must document every environment variable the app
 * and its scripts read. Scans src + scripts for both `process.env.NAME` and
 * `requireEnv("NAME")`, and asserts each appears in .env.example (as `NAME=` or
 * a commented `# NAME=`) or on the platform skip-list below. Reading a new var
 * without documenting it turns this red — the file can't silently go stale.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { scanEnvVars, SRC_DIR, SCRIPTS_DIR } from "./helpers/env-scan";

const here = path.dirname(fileURLToPath(import.meta.url));
const envExamplePath = path.resolve(here, "../../.env.example");

/**
 * Vars the runtime injects automatically — never set by hand, so they live on
 * this documented skip-list rather than in .env.example's key list.
 */
const PLATFORM_SKIP = new Set([
  "NODE_ENV",
  "HOME",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
]);

/** Var names documented in .env.example, whether `NAME=` or commented `# NAME=`. */
function documentedVars(): Set<string> {
  const text = readFileSync(envExamplePath, "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z_0-9]*)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

describe(".env.example coverage", () => {
  const scanned = scanEnvVars([SRC_DIR, SCRIPTS_DIR]);
  const documented = documentedVars();

  it("scans a plausible number of env vars (guards against a broken scan)", () => {
    expect(scanned.size).toBeGreaterThan(30);
  });

  it("documents every env var the app + scripts read", () => {
    const missing = [...scanned]
      .filter((v) => !PLATFORM_SKIP.has(v))
      .filter((v) => !documented.has(v))
      .sort();
    expect(
      missing,
      `these env vars are read in src/scripts but missing from .env.example (or the skip-list):\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("does not list a platform-injected var as a settable key", () => {
    const leaked = [...documented].filter((v) => PLATFORM_SKIP.has(v));
    expect(leaked, `platform vars must not be settable keys: ${leaked.join(", ")}`).toEqual([]);
  });
});

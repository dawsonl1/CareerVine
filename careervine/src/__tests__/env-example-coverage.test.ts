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
import fg from "fast-glob";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const scriptsDir = path.resolve(here, "../../scripts");
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

/** All env var names read via process.env.X or requireEnv("X") under src + scripts. */
function scannedVars(): Set<string> {
  // Exclude test files: they stub/mention env vars (and this file names example
  // placeholders in its own docstring), and every real config var has a
  // non-test reader — so tests add only noise, never coverage.
  const globOpts = { absolute: true, ignore: ["**/__tests__/**"] };
  const files = [
    ...fg.sync("**/*.{ts,tsx,js,mjs,cjs}", { cwd: srcDir, ...globOpts }),
    ...fg.sync("**/*.{ts,tsx,js,mjs,cjs}", { cwd: scriptsDir, ...globOpts }),
  ];
  const names = new Set<string>();
  const processEnv = /process\.env\.([A-Z][A-Z_0-9]*)/g;
  const requireEnv = /requireEnv\(\s*["']([A-Z][A-Z_0-9]*)["']\s*\)/g;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(processEnv)) names.add(m[1]);
    for (const m of text.matchAll(requireEnv)) names.add(m[1]);
  }
  return names;
}

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
  const scanned = scannedVars();
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

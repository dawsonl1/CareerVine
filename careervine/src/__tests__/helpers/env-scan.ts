/**
 * Which environment variables this repo's code actually reads.
 *
 * Extracted from `env-example-coverage.test.ts` (CAR-140) when CAR-196 needed
 * the same answer for a second question — `.env.example` must document every var
 * the app reads, and the E2E server's env allowlist must pin every var the app
 * reads. Two scanners drifting apart would let a var satisfy one gate and slip
 * the other.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `careervine/src`. */
export const SRC_DIR = path.resolve(here, "..", "..");
/** `careervine/scripts`. */
export const SCRIPTS_DIR = path.resolve(here, "..", "..", "..", "scripts");

/**
 * All env var names read via `process.env.X` or `requireEnv("X")` under `dirs`.
 *
 * Test files are excluded: they stub and mention env vars (and name example
 * placeholders in their own docstrings), and every real config var has a
 * non-test reader — so tests add only noise, never coverage. The integration
 * tier's `ITEST_*` vars are published by its own global-setup from `supabase
 * status`, never set by hand, so `__integration__` is excluded the same way.
 */
export function scanEnvVars(dirs: readonly string[]): Set<string> {
  // `dot: true` is load-bearing (CAR-196 review). fast-glob defaults to skipping
  // dot-directories, which silently excluded `src/app/.well-known/**` — the same
  // two routes CAR-158 found had never been typechecked in CI, for the same
  // reason. A `process.env.X` added there would slip BOTH gates this scanner
  // feeds: it would go undocumented in .env.example and unpinned in the E2E
  // allowlist, and an unpinned var's value is whatever the developer's shell
  // holds.
  const globOpts = {
    absolute: true,
    dot: true,
    ignore: ["**/__tests__/**", "**/__integration__/**"],
  };
  const files = dirs.flatMap((cwd) =>
    fg.sync("**/*.{ts,tsx,js,mjs,cjs}", { cwd, ...globOpts }),
  );
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

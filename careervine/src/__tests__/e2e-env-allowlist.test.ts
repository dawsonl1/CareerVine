/**
 * CAR-196: the E2E server's environment is a CLOSED set, and this is what keeps
 * it closed.
 *
 * Playwright merges into the child's environment rather than replacing it, and
 * Next loads `.env.local` inside the server process, so any var
 * `e2e/helpers/env-allowlist.ts` does not name is whatever the developer's
 * machine happens to hold. That is not hypothetical: before CAR-196 seven
 * production values reached the E2E server locally and none of them did in CI,
 * so a local green and a CI green were not testing the same application.
 *
 * A new `process.env.X` in the app therefore has to come with a decision about
 * what the E2E tier should see. This test is where that decision is forced.
 */
import { describe, it, expect } from "vitest";
import { scanEnvVars, SRC_DIR } from "./helpers/env-scan";
import {
  E2E_ENV_INHERITED,
  e2eAppEnv,
  dotenvKeys,
} from "../../e2e/helpers/env-allowlist";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Values are irrelevant here; only the key set is under test. */
const pinned = new Set(
  Object.keys(
    e2eAppEnv({
      stack: { url: "http://127.0.0.1:54321", anonKey: "anon", serviceKey: "service" },
      baseUrl: "http://localhost:3100",
      upstashUrl: "https://e2e-stub.upstash.io",
    }),
  ),
);

describe("E2E env allowlist", () => {
  // Only `src` — the E2E tier boots the app, never `scripts/`.
  const scanned = scanEnvVars([SRC_DIR]);

  it("scans a plausible number of env vars (guards against a broken scan)", () => {
    expect(scanned.size).toBeGreaterThan(30);
  });

  it("pins every env var the app reads", () => {
    const inherited = new Set<string>(E2E_ENV_INHERITED);
    const unpinned = [...scanned]
      .filter((v) => !inherited.has(v))
      .filter((v) => !pinned.has(v))
      .sort();

    expect(
      unpinned,
      "these env vars are read by src/ but are neither pinned in e2eAppEnv() nor on " +
        "E2E_ENV_INHERITED, so their value in the E2E server is whatever the developer's " +
        "shell or .env.local happens to hold:\n" +
        unpinned.join("\n"),
    ).toEqual([]);
  });

  it("does not pin a var it also declares inherited", () => {
    const both = [...pinned].filter((v) => (E2E_ENV_INHERITED as readonly string[]).includes(v));
    expect(both, `pinned and inherited are meant to be disjoint: ${both.join(", ")}`).toEqual([]);
  });

  it("neutralises every .env.local key it does not pin", () => {
    // The leak CAR-196 found was not in the vars the app reads — those were
    // already pinned — but in the ones it does not (VERCEL_OIDC_TOKEN,
    // SUPABASE_DB_PASSWORD). `e2eServerEnv` blanks them; assert the parser that
    // finds them actually works against this checkout, so the neutralisation is
    // not quietly a no-op.
    const keys = dotenvKeys(APP_DIR);
    if (keys.length === 0) {
      // CI has no .env* files at all — nothing to neutralise, nothing to assert.
      return;
    }
    expect(keys).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});

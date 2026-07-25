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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { scanEnvVars, SRC_DIR } from "./helpers/env-scan";
import {
  E2E_ENV_INHERITED,
  e2eAppEnv,
  e2eServerEnv,
  dotenvKeys,
} from "../../e2e/helpers/env-allowlist";

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

  it("neutralises .env keys it does not pin, and leaves pinned ones alone", () => {
    // Against a FIXTURE directory, not this checkout (CAR-196 review). The first
    // version of this test read the developer's own `.env*` files and bailed
    // with an early `return` when there were none — so in CI, the only
    // environment that gates a merge, it asserted nothing at all while
    // reporting green. That is the same shape of silent no-op the whole ticket
    // is about.
    //
    // Both `dotenvKeys` and `e2eServerEnv` take `appDir`, so a tmpdir fixture
    // exercises the real code identically in CI and locally.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-allowlist-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".env.local"),
        [
          "# a comment",
          "",
          "NEXT_PUBLIC_SUPABASE_URL=https://prod.supabase.co",
          "VERCEL_OIDC_TOKEN=should-not-reach-the-server",
          "export SUPABASE_DB_PASSWORD=exported-form",
          "  QSTASH_URL=https://real.example  ",
        ].join("\n"),
      );

      expect(dotenvKeys(dir).sort()).toEqual([
        "NEXT_PUBLIC_SUPABASE_URL",
        "QSTASH_URL",
        "SUPABASE_DB_PASSWORD",
        "VERCEL_OIDC_TOKEN",
      ]);

      const env = e2eServerEnv(
        {
          stack: { url: "http://127.0.0.1:54321", anonKey: "anon", serviceKey: "service" },
          baseUrl: "http://localhost:3100",
          upstashUrl: "https://e2e-stub.upstash.invalid",
        },
        dir,
      );

      // Unpinned keys are blanked, so `.env.local` cannot supply them...
      expect(env.VERCEL_OIDC_TOKEN).toBe("");
      expect(env.SUPABASE_DB_PASSWORD).toBe("");
      // ...pinned keys keep the value the tier chose, not the file's...
      expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
      // ...and a var a DEPENDENCY reads is pinned to a real value, never "",
      // because `""` is absent to a falsy check but not to a `??`.
      expect(env.QSTASH_URL).toBe("https://qstash.upstash.io");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blanks ambient vars that are not OS or toolchain plumbing", () => {
    // The closure has to cover the parent process too: Playwright merges
    // `{...process.env, ...webServer.env}`, so before CAR-196's review 62 of 74
    // ambient vars reached the server, eleven of them live credentials.
    const marker = "CAR196_AMBIENT_PROBE_TOKEN";
    const previous = process.env[marker];
    process.env[marker] = "a-shell-secret";
    try {
      const env = e2eServerEnv(
        {
          stack: { url: "http://127.0.0.1:54321", anonKey: "anon", serviceKey: "service" },
          baseUrl: "http://localhost:3100",
          upstashUrl: "https://e2e-stub.upstash.invalid",
        },
        os.tmpdir(),
      );
      expect(env[marker], "an unpinned ambient var must not reach the server").toBe("");
      // Plumbing survives, or `next build` cannot run.
      expect(env.PATH).toBeUndefined(); // inherited, never overridden
    } finally {
      if (previous === undefined) delete process.env[marker];
      else process.env[marker] = previous;
    }
  });
});

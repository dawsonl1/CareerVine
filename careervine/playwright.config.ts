/**
 * E2E tier (CAR-189): real Chromium against a real production build of the app,
 * backed by the LOCAL Supabase stack (real Postgres, PostgREST, GoTrue, RLS at
 * the full migration chain).
 *
 * Run it:
 *   supabase start -x studio,imgproxy,edge-runtime,realtime,storage-api,vector,logflare,supavisor
 *   npm run test:e2e
 *
 * Mailpit must NOT be excluded from that start command: `enable_confirmations`
 * is on (matching production), so the signup flow reads the real confirmation
 * email out of Mailpit. See CONVENTIONS.md section i.
 *
 * Three things keep this tier off production, independently:
 *  1. `stackEnv()` refuses any non-loopback Supabase URL.
 *  2. `e2e/helpers/env-allowlist.ts` hands the server a CLOSED set of env vars.
 *     `@next/env` never overwrites a var already on `process.env`, so these beat
 *     `.env.local` — which on a developer machine points at PRODUCTION.
 *  3. `e2e/server-stubs/register.mjs` denies every non-loopback origin from
 *     inside the server process, so the wire itself is closed, and every denial
 *     is asserted by the `networkGuard` fixture rather than merely logged.
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { stackEnv } from "./e2e/helpers/stack-env";
import { e2eServerEnv } from "./e2e/helpers/env-allowlist";
import { BASE_URL, E2E_PORT, STUB_LOG_PATH } from "./e2e/helpers/ports";

const stack = stackEnv();

/**
 * The E2E server's environment, pinned rather than inherited.
 *
 * Playwright merges into the child's env (`{...process.env, ...webServer.env}`)
 * and Next loads `.env.local` inside the server process, so anything not named
 * here is whatever the developer's machine happens to hold. Before CAR-196 that
 * meant seven production values reached the E2E server locally and none did in
 * CI — a local green and a CI green were not testing the same app. See that
 * module's header; `src/__tests__/e2e-env-allowlist.test.ts` keeps it complete.
 */
const serverEnv = e2eServerEnv(
  { stack, baseUrl: BASE_URL, upstashUrl: "https://e2e-stub.upstash.io" },
  path.resolve(__dirname),
);

export default defineConfig({
  testDir: "./e2e",
  // Clears the stub layer's denial log once per run. See that file for why this
  // cannot live in the config's module scope or in the preload itself.
  globalSetup: "./e2e/global-setup.ts",
  // One shared database, and the flows write to it. Serial within a file is not
  // enough — run the whole tier single-worker so one spec's sweep cannot eat
  // another's rows, exactly as vitest.integration.config.ts does with
  // `fileParallelism: false`.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Retries are for infrastructure flake only. A test that passes only on retry
  // is a bug report, not a pass — investigate it rather than raising this.
  retries: process.env.CI ? 2 : 0,
  // ...and that policy is now enforced rather than merely stated (CAR-196).
  // Without this, a test that fails then passes prints "1 flaky" and exits 0,
  // so the retries above quietly converted real bugs into green runs. Safe to
  // set unconditionally: `retries` is 0 locally, so nothing can be flaky there.
  failOnFlakyTests: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      // Runs after every project that depends on `setup` has finished. This is
      // the teardown `e2e/helpers/tenant.ts` has documented since CAR-189 while
      // nothing declared it: `deleteTenant` had zero call sites, and a local
      // stack had accumulated 21 orphaned `itest-e2e-*` tenants by the time
      // CAR-196 counted them.
      teardown: "cleanup",
    },
    {
      name: "cleanup",
      testMatch: /.*\.teardown\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    // A production build, not `next dev`: dev double-renders under StrictMode
    // and compiles on demand, both of which change the timing the tests observe.
    // NEXT_PUBLIC_* are inlined at BUILD time, so the build must carry the local
    // stack's values — which is why they are in `env` rather than only on start.
    command: "npx next build && npx next start -p " + E2E_PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...serverEnv,
      NODE_ENV: "production",
      // `next build` posts to telemetry.nextjs.org, which the stub layer then
      // correctly denies — 12 times in the first CI run. Benign, but it buries
      // the genuinely-unexpected calls in the DENIED summary, which is the one
      // signal that has to stay readable. Turn the source off instead.
      NEXT_TELEMETRY_DISABLED: "1",
      // Shared log the stub layer appends denials to, so the networkGuard
      // fixture can assert on server-side denials rather than only logging them.
      E2E_STUB_LOG: STUB_LOG_PATH,
      // Arms the server-side third-party interception before Next loads any
      // route module. See e2e/server-stubs/register.mjs for why this is not
      // page.route().
      NODE_OPTIONS: "--import ./e2e/server-stubs/register.mjs",
    },
  },
});

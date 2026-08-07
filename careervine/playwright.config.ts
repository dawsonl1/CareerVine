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
 * Three things keep this tier off production:
 *  1. `stackEnv()` refuses any non-loopback Supabase URL.
 *  2. `e2e/helpers/env-allowlist.ts` hands the server a closed set of env vars —
 *     closed over the ambient environment, over every `.env*` key, and over
 *     everything the app reads. `@next/env` never overwrites a var already on
 *     `process.env`, so these beat `.env.local` — which on a developer machine
 *     points at PRODUCTION.
 *  3. `e2e/server-stubs/register.mjs` denies every non-loopback origin from
 *     inside the server process, so the wire itself is closed, and every denial
 *     is asserted by the `networkGuard` fixture rather than merely logged.
 *
 * Guards 2 and 3 apply to a server PLAYWRIGHT STARTS. `reuseExistingServer`
 * below deliberately skips the whole webServer block when the port is already
 * busy, and a server started from another shell has neither. That is why
 * `e2e/global-setup.ts` fails the run when the arming receipt is missing: the
 * guarantee is real, but it needed something to enforce that it was in force.
 */
import crypto from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { stackEnv } from "./e2e/helpers/stack-env";
import { e2eServerEnv } from "./e2e/helpers/env-allowlist";
import { BASE_URL, E2E_PORT, STUB_LOG_PATH, STUB_ARMED_PATH } from "./e2e/helpers/ports";

const stack = stackEnv();

/**
 * One nonce per run, the thing `global-setup.ts` makes the server prove it holds
 * (CAR-273).
 *
 * `??=` and `process.env` rather than a plain const: this config file is
 * re-evaluated in every worker process, and a fresh value there would not match
 * the one the server was started with. Workers are children of the Playwright
 * main process, so assigning it here makes them inherit the same value.
 */
process.env.E2E_ARMING_NONCE ??= crypto.randomUUID();
const ARMING_NONCE = process.env.E2E_ARMING_NONCE;

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
  // `.invalid` is reserved by RFC 6761 and can never resolve, so the rate-limit
  // stub's host is provably not a real service even if a request somehow escaped
  // MSW. `register.mjs` also refuses to build a handler for any host that is not
  // `.invalid`, which is what keeps a stray real Upstash URL denied by name.
  { stack, baseUrl: BASE_URL, upstashUrl: "https://e2e-stub.upstash.invalid" },
  path.resolve(__dirname),
);

export default defineConfig({
  testDir: "./e2e",
  // Asserts the stub layer armed in the server this run will test, and that the
  // build phase reached nothing external. Runs after the webServer is up, which
  // is what makes both checks possible; see that file for the task ordering.
  globalSetup: "./e2e/global-setup.ts",
  // Catches denials that belong to no test's window — background `waitUntil`
  // work, or anything after the last spec.
  globalTeardown: "./e2e/global-teardown.ts",
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
      // Receipt proving THIS run's server armed the stub layer. Checked by
      // global-setup.ts, because an empty denial log and an absent stub layer
      // are otherwise the same observation.
      E2E_STUB_ARMED: STUB_ARMED_PATH,
      // What makes that receipt mean "and it is the process SERVING the port"
      // (CAR-273). The stub layer answers /__e2e__/arming with this value from
      // memory; a server belonging to any other run answers with a different
      // one, or does not answer at all.
      E2E_ARMING_NONCE: ARMING_NONCE,
      // Arms the server-side third-party interception before Next loads any
      // route module. See e2e/server-stubs/register.mjs for why this is not
      // page.route().
      NODE_OPTIONS: "--import ./e2e/server-stubs/register.mjs",
    },
  },
});

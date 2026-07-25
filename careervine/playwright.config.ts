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
 *  2. Every Supabase var is passed explicitly below. `@next/env` never
 *     overwrites a var already on `process.env`, so these beat `.env.local` —
 *     which on a developer machine points at PRODUCTION.
 *  3. `e2e/server-stubs/register.mjs` denies every non-loopback origin from
 *     inside the server process, so the wire itself is closed.
 */
import { defineConfig, devices } from "@playwright/test";
import { stackEnv } from "./e2e/helpers/stack-env";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * `localhost`, not `127.0.0.1`, and this is load-bearing.
 *
 * `/auth/confirm` finishes with `NextResponse.redirect(new URL(next, request.url))`.
 * In Next 16 `NextRequest.url` normalises its host to `localhost` no matter what
 * the Host header says or what `next start -H` binds to (measured). So a run
 * based at `http://127.0.0.1:3100` sets the session cookie on 127.0.0.1, is then
 * redirected to localhost:3100, and arrives with no cookie — every
 * authenticated spec silently lands on the signed-out landing page.
 *
 * Keeping every origin on `localhost` keeps the cookie and the redirect on one
 * host. Both are loopback, so the guards in stack-env.ts, server-stubs and the
 * network fixture accept it.
 */
const BASE_URL = `http://localhost:${PORT}`;

const stack = stackEnv();

/**
 * Non-secret placeholders, mirroring the CI `web` job's build env: Next collects
 * page data by evaluating route modules, some of which validate env at module
 * scope, so every var read at import time needs a value. Nothing here is
 * reachable anyway — the stub layer denies all external origins.
 *
 * NEXT_PUBLIC_POSTHOG_KEY is deliberately absent: unset makes `trackServer` and
 * the browser SDK no-ops, so no analytics traffic is generated to deny.
 */

/**
 * `BYOK_ENCRYPTION_KEY` must parse as a 32-byte base64 key or the module-scope
 * validation in the BYOK path throws during `next build`. Constructed rather
 * than pasted as a literal: a hardcoded 44-char base64 string is
 * indistinguishable from a real AES key to a secret scanner (GitGuardian
 * flagged exactly that), and building it from constant bytes says plainly that
 * there is no key here. Byte-identical to the placeholder the CI `web` job uses.
 */
const PLACEHOLDER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const appEnv: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: stack.url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.anonKey,
  SUPABASE_SERVICE_ROLE_KEY: stack.serviceKey,
  // `src/lib/supabase/config.ts` prefers the *_LOCAL vars when NODE_ENV is
  // development. `next start` is production, so they are not consulted — but
  // pin them anyway so a stray .env.local value can never win.
  NEXT_PUBLIC_SUPABASE_URL_LOCAL: stack.url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL: stack.anonKey,

  NEXT_PUBLIC_APP_URL: BASE_URL,
  APP_BASE_URL: BASE_URL,
  NEXT_PUBLIC_EXTENSION_STORE_URL: "https://chromewebstore.google.com/detail/placeholder",
  NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",

  OPENAI_API_KEY: "sk-placeholder",
  OPENAI_MODEL: "gpt-4o-mini",
  GOOGLE_CLIENT_ID: "placeholder.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "placeholder",
  GOOGLE_REDIRECT_URI: `${BASE_URL}/api/gmail/callback`,
  DEEPGRAM_API_KEY: "placeholder",
  SERPER_API_KEY: "placeholder",
  QSTASH_TOKEN: "placeholder",
  QSTASH_CURRENT_SIGNING_KEY: "sig_placeholder",
  QSTASH_NEXT_SIGNING_KEY: "sig_placeholder",
  // UPSTASH_REDIS_REST_{URL,TOKEN} are deliberately ABSENT, not placeholders.
  // `src/lib/rate-limit.ts` degrades to allow-all when they are unset, which is
  // exactly what this tier wants; pointing them at a placeholder instead builds
  // a live Redis client that then throws `TypeError: fetch failed` on every
  // limited route. A loopback placeholder is worse still — loopback is what the
  // stub layer passes through, so a dead local port bypasses deny-by-default
  // and fails as a connection error rather than a named DENIED line.
  BYOK_ENCRYPTION_KEY: PLACEHOLDER_ENCRYPTION_KEY,
  BUNDLE_ADMIN_TOKEN: "placeholder",
  R2_ACCOUNT_ID: "placeholder",
  R2_ACCESS_KEY_ID: "placeholder",
  R2_SECRET_ACCESS_KEY: "placeholder",
  R2_BUCKET: "placeholder-bucket",
  R2_PUBLIC_BASE_URL: "https://placeholder.r2.dev",
  RESEND_API_KEY: "re_placeholder",
  APIFY_API_TOKEN: "placeholder",
  APIFY_WEBHOOK_SECRET: "placeholder",
  NUDGE_UNSUBSCRIBE_SECRET: "placeholder",
};

export default defineConfig({
  testDir: "./e2e",
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
    command: "npx next build && npx next start -p " + PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...appEnv,
      NODE_ENV: "production",
      // `next build` posts to telemetry.nextjs.org, which the stub layer then
      // correctly denies — 12 times in the first CI run. Benign, but it buries
      // the genuinely-unexpected calls in the DENIED summary, which is the one
      // signal that has to stay readable. Turn the source off instead.
      NEXT_TELEMETRY_DISABLED: "1",
      // Arms the server-side third-party interception before Next loads any
      // route module. See e2e/server-stubs/register.mjs for why this is not
      // page.route().
      NODE_OPTIONS: "--import ./e2e/server-stubs/register.mjs",
    },
  },
});

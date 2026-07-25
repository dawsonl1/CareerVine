/**
 * The closed set of environment variables the E2E server runs with (CAR-196).
 *
 * WHY AN ALLOWLIST RATHER THAN A FEW OVERRIDES:
 * Playwright does not replace the child's environment, it merges into it —
 * `env: { ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...webServer.env }`.
 * On top of that, Next loads `.env.local` inside the server process itself, and
 * `@next/env` applies a parsed key only when `typeof initialEnv[key] ===
 * "undefined"`. So *anything this file does not name* is whatever the developer's
 * shell and `.env.local` happen to hold — which on this repo's dev machines is
 * production credentials.
 *
 * That was not theoretical. Before CAR-196 seven keys reached the E2E server from
 * `.env.local` (`QSTASH_URL`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_URL_LOCAL`,
 * `SUPABASE_SERVICE_ROLE_KEY_LOCAL`, `UPSTASH_REDIS_REST_URL`,
 * `UPSTASH_REDIS_REST_TOKEN`, `VERCEL_OIDC_TOKEN`), so a local run tested a
 * differently-configured app than CI did. No credential ever left the machine —
 * the stub layer denies every non-loopback origin before the wire — but "local
 * and CI run the same app" is the whole basis for trusting a green E2E run.
 *
 * `""` is a real value here, not an omission: it is how a var is made to read as
 * ABSENT while still blocking `@next/env` from filling it in from `.env.local`
 * (empty string is falsy, and `typeof "" !== "undefined"`).
 *
 * `src/__tests__/e2e-env-allowlist.test.ts` fails when the app learns to read a
 * var this file does not pin.
 */
import fs from "node:fs";
import path from "node:path";

export interface AllowlistInputs {
  /** Local Supabase stack endpoints, from `stackEnv()`. */
  stack: { url: string; anonKey: string; serviceKey: string };
  /** Origin the app is served on, e.g. `http://localhost:3100`. */
  baseUrl: string;
  /** Origin the Upstash rate-limit stub answers on. */
  upstashUrl: string;
}

/**
 * Vars the E2E server inherits from the ambient process on purpose.
 *
 * `PATH`/`HOME`/`SHELL`/`TMPDIR` and friends are not app config — `npx next
 * build` needs them. `NODE_ENV` is pinned by the webServer block itself.
 * `ITEST_*` are published at runtime by `e2e/helpers/tenant.ts` for the
 * integration-tier helpers it reuses, and are read only by the Playwright
 * process, never by the server.
 */
export const E2E_ENV_INHERITED: readonly string[] = [
  "NODE_ENV",
  "PATH",
  "HOME",
  "CI",
  "ITEST_SUPABASE_URL",
  "ITEST_ANON_KEY",
  "ITEST_SERVICE_ROLE_KEY",
  "ITEST_DB_URL",
  // Read only by tests, to opt into a debug dump.
  "DUMP_QUERY_SHAPES",
  // Injected by Vercel in production; absent here by construction, and the
  // fallbacks the app takes when they are missing are the ones under test.
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
];

/**
 * `BYOK_ENCRYPTION_KEY` must parse as a 32-byte base64 key or the module-scope
 * validation in the BYOK path throws during `next build`. Constructed rather
 * than pasted as a literal: a hardcoded 44-char base64 string is
 * indistinguishable from a real AES key to a secret scanner (GitGuardian
 * flagged exactly that), and building it from constant bytes says plainly that
 * there is no key here. Byte-identical to the placeholder the CI `web` job uses.
 */
const PLACEHOLDER_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");

/**
 * Every var the app reads, pinned to the value the E2E tier wants it to have.
 *
 * Non-secret placeholders, mirroring the CI `web` job's build env: Next collects
 * page data by evaluating route modules, some of which validate env at module
 * scope, so every var read at import time needs a value. Nothing here is
 * reachable anyway — the stub layer denies all external origins.
 */
export function e2eAppEnv({ stack, baseUrl, upstashUrl }: AllowlistInputs): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: stack.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceKey,
    // `src/lib/supabase/config.ts` prefers the *_LOCAL vars when NODE_ENV is
    // development. `next start` is production, so they are not consulted — but
    // pin them anyway so a stray .env.local value can never win.
    NEXT_PUBLIC_SUPABASE_URL_LOCAL: stack.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL: stack.anonKey,
    SUPABASE_SERVICE_ROLE_KEY_LOCAL: stack.serviceKey,
    // Would force the prod project even with the URLs above pointed at the local
    // stack. Pinned to the empty string so `.env.local` cannot set it to "true".
    NEXT_PUBLIC_SUPABASE_USE_PROD: "",
    // Only the Supabase CLI reads these, never the app. Pinned so `.env.local`'s
    // production values do not reach the server process at all.
    SUPABASE_ACCESS_TOKEN: "",

    NEXT_PUBLIC_APP_URL: baseUrl,
    APP_BASE_URL: baseUrl,
    NEXT_PUBLIC_EXTENSION_STORE_URL: "https://chromewebstore.google.com/detail/placeholder",
    NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    // Deliberately empty: unset makes `trackServer` and the browser SDK no-ops,
    // so no analytics traffic is generated for the stub layer to deny.
    NEXT_PUBLIC_POSTHOG_KEY: "",
    POSTHOG_PROJECT_ID: "",
    POSTHOG_PERSONAL_API_KEY: "",

    OPENAI_API_KEY: "sk-placeholder",
    OPENAI_MODEL: "gpt-4o-mini",
    SHARED_AI_SPEND_LIMIT_USD: "1000",
    GOOGLE_CLIENT_ID: "placeholder.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "placeholder",
    GOOGLE_REDIRECT_URI: `${baseUrl}/api/gmail/callback`,
    DEEPGRAM_API_KEY: "placeholder",
    SERPER_API_KEY: "placeholder",
    QSTASH_TOKEN: "placeholder",
    QSTASH_CURRENT_SIGNING_KEY: "sig_placeholder",
    QSTASH_NEXT_SIGNING_KEY: "sig_placeholder",

    /**
     * Pointed at the stub rather than left absent (CAR-196).
     *
     * Absent looks tidier — `rate-limit.ts` degrades to allow-all without them —
     * but only for the fail-OPEN buckets. The seven fail-CLOSED ones (both BYOK
     * key-save routes, `parse-profile`, and the four AI draft routes) deny when
     * there is no limiter and `NODE_ENV === "production"`, which `next start`
     * always is. With these unset, every one of those routes 429s in CI, which
     * is what made CAR-191's flow 7 unrunnable before a line of it was written.
     *
     * A placeholder pointed at a real-looking host is safe here *because* there
     * is a handler for it: `e2e/server-stubs/register.mjs` answers the pipeline
     * endpoint, so the limiter runs its real code path and allows. A loopback
     * placeholder would be worse than either — loopback is what the stub layer
     * passes through, so a dead local port would bypass deny-by-default and fail
     * as a connection error rather than a named DENIED line.
     */
    UPSTASH_REDIS_REST_URL: upstashUrl,
    UPSTASH_REDIS_REST_TOKEN: "placeholder",

    BYOK_ENCRYPTION_KEY: PLACEHOLDER_ENCRYPTION_KEY,
    BUNDLE_ADMIN_TOKEN: "placeholder",
    R2_ACCOUNT_ID: "placeholder",
    R2_ACCESS_KEY_ID: "placeholder",
    R2_SECRET_ACCESS_KEY: "placeholder",
    R2_BUCKET: "placeholder-bucket",
    R2_PUBLIC_BASE_URL: "https://placeholder.r2.dev",
    RESEND_API_KEY: "re_placeholder",
    // Dead account (see the repo's ops notes); the app still reads it, and the
    // stub layer denies the origin. Pinned empty so `admin-notify` takes its
    // not-configured branch instead of building a client that cannot send.
    SENDGRID_API_KEY: "",
    APIFY_API_TOKEN: "placeholder",
    APIFY_WEBHOOK_SECRET: "placeholder",
    // The scrape kill switch reads `=== "true"`, so empty leaves scraping on —
    // matching production, where the switch is off.
    APIFY_SCRAPE_DISABLED: "",
    NUDGE_UNSUBSCRIBE_SECRET: "placeholder",
  };
}

/** The `.env*` files Next loads when `NODE_ENV=production`, in its own order. */
const NEXT_ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

/**
 * Keys defined in this checkout's `.env*` files.
 *
 * Parsed with the same `KEY=` shape `.env.example`'s coverage test uses; only
 * the names matter, never the values, so nothing secret is read into memory
 * beyond the line already on disk.
 */
export function dotenvKeys(appDir: string): string[] {
  const keys = new Set<string>();
  for (const file of NEXT_ENV_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(appDir, file), "utf8");
    } catch {
      continue; // Absent in CI, which is the point of neutralising them locally.
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}

/**
 * The complete environment handed to the E2E webServer.
 *
 * Pinned app vars, plus `""` for every remaining key any `.env*` file defines —
 * so a var this file does not know about (`VERCEL_OIDC_TOKEN`,
 * `SUPABASE_DB_PASSWORD`) cannot reach the server either, and a local run and a
 * CI run see the same environment.
 */
export function e2eServerEnv(inputs: AllowlistInputs, appDir: string): Record<string, string> {
  const app = e2eAppEnv(inputs);
  const neutralised: Record<string, string> = {};
  for (const key of dotenvKeys(appDir)) {
    if (!(key in app)) neutralised[key] = "";
  }
  return { ...neutralised, ...app };
}

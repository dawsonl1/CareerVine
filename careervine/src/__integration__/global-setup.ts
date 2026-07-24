/**
 * Global setup for the integration tier (CAR-178).
 *
 * Resolves the RUNNING local Supabase stack's endpoints and keys via
 * `supabase status -o env` (run from the repo root, where config.toml lives)
 * and publishes them into process.env, where vitest workers inherit them:
 *
 *   ITEST_SUPABASE_URL / ITEST_ANON_KEY / ITEST_SERVICE_ROLE_KEY / ITEST_DB_URL
 *     — read by the harness helpers (src/__integration__/helpers/stack.ts).
 *
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
 *   SUPABASE_SERVICE_ROLE_KEY
 *     — the vars app code reads (getSupabaseEnv), FORCE-overwritten so any
 *       code under test that constructs its own client (e.g.
 *       createSupabaseServiceClient inside a cron helper) talks to the local
 *       stack, never to whatever a stray .env.local points at.
 *
 * Safety: refuses to proceed unless the API URL is loopback. This tier
 * mutates and deletes data at will; it must be structurally unable to run
 * against a hosted instance.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup() {
  const repoRoot = path.resolve(__dirname, '../../..');

  let raw: string;
  try {
    raw = execFileSync('supabase', ['status', '-o', 'env'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Could not read local Supabase status (is the stack running?).\n` +
        `Start it from the repo root first:\n  supabase start\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }

  const apiUrl = env.API_URL;
  const anonKey = env.ANON_KEY;
  const serviceKey = env.SERVICE_ROLE_KEY;
  const dbUrl = env.DB_URL;
  if (!apiUrl || !anonKey || !serviceKey || !dbUrl) {
    throw new Error(
      `\`supabase status -o env\` did not report a running stack ` +
        `(missing API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL).\n` +
        `Start it from the repo root first:\n  supabase start\nOutput was:\n${raw}`,
    );
  }

  const isLoopback = (url: string) =>
    /^[a-z+]+:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(url) ||
    /@(127\.0\.0\.1|localhost|\[::1\]):/.test(url);
  if (!isLoopback(apiUrl) || !isLoopback(dbUrl)) {
    throw new Error(
      `Refusing to run the integration tier against a non-local stack: ` +
        `API_URL=${apiUrl} DB_URL=${dbUrl}. This tier destroys data.`,
    );
  }

  process.env.ITEST_SUPABASE_URL = apiUrl;
  process.env.ITEST_ANON_KEY = anonKey;
  process.env.ITEST_SERVICE_ROLE_KEY = serviceKey;
  process.env.ITEST_DB_URL = dbUrl;

  // Force app-code env at the local stack (deliberate overwrite, see header).
  process.env.NEXT_PUBLIC_SUPABASE_URL = apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
}

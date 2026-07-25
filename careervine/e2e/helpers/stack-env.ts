/**
 * Local-stack resolution for the E2E tier (CAR-189).
 *
 * Same contract as the integration tier's `src/__integration__/global-setup.ts`:
 * read the running stack's endpoints out of `supabase status -o env` and
 * **refuse anything that is not loopback**, so this tier is structurally unable
 * to point at production.
 *
 * That guard matters more here than it does for the integration tier, because
 * this tier boots the real Next app, and `careervine/.env.local` points at
 * PRODUCTION Supabase. Next loads `.env.local` automatically. Three things stop
 * that from mattering, in order:
 *
 *  1. `playwright.config.ts` passes every Supabase var explicitly to both the
 *     build and the server. `@next/env` never overwrites a var that is already
 *     on `process.env`, so ours win.
 *  2. This function refuses to hand back a non-loopback URL at all.
 *  3. `e2e/server-stubs/register.mjs` denies every non-loopback origin inside
 *     the server process, so even a misconfigured build cannot reach
 *     `*.supabase.co` over the wire.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface StackEnv {
  url: string;
  anonKey: string;
  serviceKey: string;
  dbUrl: string;
  /** Mailpit's HTTP API base, used by the signup flow to read the real email. */
  mailpitUrl: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function assertLoopback(name: string, value: string): string {
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run E2E against a non-local stack: ${name} resolved to ${host}. ` +
        `This tier writes and deletes real rows.`,
    );
  }
  return value;
}

let cached: StackEnv | undefined;

/**
 * Resolves once per process. Throws with an actionable message when the stack
 * is not running, rather than letting Playwright fail later on a connection
 * refused that reads like a product bug.
 */
export function stackEnv(): StackEnv {
  if (cached) return cached;

  // `supabase status` is repo-root-scoped (it reads supabase/config.toml).
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "Could not read `supabase status`. Start the local stack first:\n" +
        "  supabase start -x studio,imgproxy,edge-runtime,realtime,storage-api,vector,logflare,supavisor\n" +
        "Note: Mailpit must NOT be excluded — the signup flow reads the real " +
        "confirmation email from it (see CONVENTIONS.md section i).\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const parsed = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    parsed.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"|"$/g, ""));
  }

  const need = (key: string): string => {
    const v = parsed.get(key);
    if (!v) throw new Error(`supabase status did not report ${key}`);
    return v;
  };

  const url = assertLoopback("API_URL", need("API_URL"));
  cached = {
    url,
    anonKey: need("ANON_KEY"),
    serviceKey: need("SERVICE_ROLE_KEY"),
    dbUrl: need("DB_URL"),
    // Not reported by `supabase status -o env`; it is a fixed local port
    // (`[local_smtp] port` in supabase/config.toml).
    mailpitUrl: "http://127.0.0.1:54324",
  };
  return cached;
}

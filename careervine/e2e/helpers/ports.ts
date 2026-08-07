/**
 * Where the E2E tier runs, and where its two halves meet (CAR-196).
 *
 * Shared because separate processes have to agree on these and each learns about
 * them differently: `playwright.config.ts` (which starts the server),
 * `e2e/fixtures/test.ts` (which runs in a worker process and reads denials
 * back), and `e2e/server-stubs/register.mjs` (raw Node inside the server, which
 * gets `E2E_STUB_LOG` handed to it as a string in the webServer env).
 */
import crypto from "node:crypto";
import path from "node:path";

/** The checkout this file belongs to — different per worktree, by construction. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * A port in [3100, 3199] derived from the checkout path.
 *
 * Every worktree used to default to 3100, which is how CAR-273 happened: a
 * second worktree's server armed the stub layer, failed to `listen` with
 * EADDRINUSE, and Playwright — having already seen the port busy under
 * `reuseExistingServer` — ran 21 tests against the FIRST worktree's build.
 *
 * Deriving the port removes the collision rather than detecting it. It does NOT
 * make concurrent runs safe on its own: the local Supabase stack is shared and
 * `tenant.teardown.ts` sweeps by prefix, so two runs still delete each other's
 * tenants on different ports. `e2e/helpers/stack-lock.ts` is what covers that.
 */
function derivePort(root: string): number {
  const digest = crypto.createHash("sha256").update(root).digest();
  return 3100 + (digest.readUInt16BE(0) % 100);
}

export const E2E_PORT = Number(process.env.E2E_PORT ?? derivePort(REPO_ROOT));

/** Exported for the unit test; not used at runtime. */
export const __derivePortForTest = derivePort;

/**
 * Where the stub layer answers "which run do I belong to?".
 *
 * Served from inside `register.mjs` by patching the HTTP server, NOT by a route
 * under `src/app/`: a real route would ship in the production bundle, and this
 * has to exist only where the preload is loaded. See `global-setup.ts` for what
 * the answer proves that the on-disk receipt cannot.
 */
export const ARMING_ENDPOINT = "/__e2e__/arming";

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
export const BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * Append-only log of every outbound call the stub layer denied — the channel the
 * `networkGuard` fixture asserts on.
 *
 * A FILE rather than the `GET /__e2e__/stub-calls` endpoint CAR-196 originally
 * specified, because `NODE_OPTIONS=--import` applies to every Node process the
 * command starts, not just the server. Measured on this repo: a single
 * `next build` arms the preload in **eleven** processes (the npx wrapper, the
 * `next` bin, a jest-worker thread child, six `processChild` workers, and a
 * compiled build script). Route modules are evaluated inside those workers
 * during page-data collection, so a denial can happen in any of them. One
 * process owning a listener would have meant every other process's denials going
 * unrecorded — and the first attempt simply crashed the server with EADDRINUSE.
 *
 * Shared, append-only state is the shape that actually fits: any process can
 * write, ordering is preserved, and the Playwright side slices by index. One
 * line per denial, plain text rather than JSON, so a torn concurrent write still
 * reads as a denial and fails loudly instead of throwing in a parser.
 *
 * Under `test-results/`, which is gitignored and which `e2e/global-setup.ts`
 * clears once per run.
 */
export const STUB_LOG_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "test-results",
  "e2e-stub-denials.log",
);

/**
 * Proof that the stub layer actually armed in the server this run is testing.
 *
 * A SEPARATE file from the denial log, not a line in it — `e2e/fixtures/test.ts`
 * treats every line of that log as a denial.
 *
 * This exists because "no denials" and "no stub layer" were indistinguishable,
 * and one path reaches the second state routinely: `reuseExistingServer` is on
 * locally, and Playwright's webServer plugin returns *before* `launchProcess`
 * when the port is already busy — so `webServer.env` is never applied. A server
 * left running from another shell has no MSW, no pinned env, and is built from
 * `.env.local`, which on this repo's dev machines points at PRODUCTION Supabase.
 * Every spec would report the server half clean, forever. That is the same
 * false-green class CAR-196 exists to close, just relocated from "denials only
 * printed" to "denials never generated".
 *
 * The ordering that makes this work is Playwright's own, verified in
 * `runner/index.js`: `createRemoveOutputDirsTask()` wipes `test-results/`, THEN
 * the webServer plugin builds and starts the server, THEN `globalSetup` runs. So
 * a marker under `test-results/` cannot survive from a previous run, and
 * `e2e/global-setup.ts` is the first code that can observe whether this run's
 * server armed.
 */
export const STUB_ARMED_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "test-results",
  "e2e-stub-armed",
);

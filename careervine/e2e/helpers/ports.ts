/**
 * Where the E2E tier runs, and where its two halves meet (CAR-196).
 *
 * Shared because separate processes have to agree on these and each learns about
 * them differently: `playwright.config.ts` (which starts the server),
 * `e2e/fixtures/test.ts` (which runs in a worker process and reads denials
 * back), and `e2e/server-stubs/register.mjs` (raw Node inside the server, which
 * gets `E2E_STUB_LOG` handed to it as a string in the webServer env).
 */
import path from "node:path";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);

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

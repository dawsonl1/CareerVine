/**
 * Runs in the Playwright main process, AFTER the webServer is up (CAR-196).
 *
 * The ordering is not what it looks like, and two of this file's jobs depend on
 * getting it right. Playwright builds its startup tasks in
 * `runner/index.js`'s `createGlobalSetupTasks` as:
 *
 *   createRemoveOutputDirsTask()   →  wipes test-results/
 *   ...createPluginSetupTasks()    →  webServer: `next build && next start`, awaited to ready
 *   ...globalSetups                →  THIS FILE
 *
 * So by the time this runs, `test-results/` has already been cleared for us and
 * the whole build has already happened. An earlier version of this file said it
 * ran "before anything else" and deleted the denial log to clear "a previous
 * run's leftovers" — both wrong. There are no leftovers (Playwright removed
 * them), and the only thing that delete actually destroyed was THIS run's
 * build-phase denials.
 *
 * That erasure mattered: `next build` arms the stub layer in eleven processes,
 * six of which evaluate route modules, and this tier has already seen a real
 * build-phase denial (12 calls to telemetry.nextjs.org in the first CI run).
 * Erased, such a call fails nothing and leaves no artifact. So this file now
 * ASSERTS the build phase instead of deleting it.
 */
import fs from "node:fs";
import path from "node:path";
import { ARMING_ENDPOINT, BASE_URL, E2E_PORT, STUB_LOG_PATH, STUB_ARMED_PATH } from "./helpers/ports";
import { acquireStackLock } from "./helpers/stack-lock";
import { stackEnv } from "./helpers/stack-env";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(path.dirname(STUB_LOG_PATH), { recursive: true });

  // 0. Is another run already using this Supabase stack?
  //
  // Before any tenant exists, because the corruption this prevents is two runs
  // deleting each other's tenants: `tenant.teardown.ts` sweeps by PREFIX, so it
  // takes every `itest-e2e-*` row, not only the one its own run created. A
  // tenant vanishing mid-run is indistinguishable from a bug in the code under
  // test, which is why this refuses rather than queues.
  const stack = stackEnv();
  const lock = acquireStackLock(stack.dbUrl, REPO_ROOT);
  if (!lock.ok) {
    const holder = lock.heldBy;
    throw new Error(
      "[e2e] another E2E run is already using this local Supabase stack" +
        (holder ? `:\n  pid ${holder.pid}, started ${holder.startedAt}\n  ${holder.root}` : ".") +
        "\nEvery worktree shares one local stack, and tenant.teardown.ts deletes every " +
        "itest-e2e-* tenant, so two runs would delete each other's data mid-flight. " +
        "Deriving a per-worktree port does not help with that.\n" +
        "Wait for that run to finish, or stop it and re-run.",
    );
  }
  if (lock.stolenFrom) {
    console.log(
      `[e2e] took over a stale stack lock from dead pid ${lock.stolenFrom.pid} ` +
        `(${lock.stolenFrom.root}).`,
    );
  }

  // 1. Did the stub layer arm in the server this run is about to test?
  //
  // This is the check that makes "the denial log is empty" mean anything. The
  // path that reaches a live server with no stub layer is ordinary, not exotic:
  // `reuseExistingServer` is on locally, and Playwright's webServer plugin
  // returns before `launchProcess` when the port is already busy, so a server
  // from another shell gets none of the webServer env — no MSW, no pinned vars,
  // and `.env.local`, which points at PRODUCTION Supabase. Every spec would then
  // report the server half clean, forever.
  if (!fs.existsSync(STUB_ARMED_PATH)) {
    throw new Error(
      `[e2e] the server on this run did not arm the stub layer (no ${STUB_ARMED_PATH}).\n` +
        "Almost always this means Playwright reused a server it did not start: something " +
        "was already listening on the E2E port, so webServer.env — the MSW preload AND the " +
        "pinned environment — was never applied. That server is unstubbed and may be built " +
        "against production credentials.\n" +
        "Stop whatever is on the port and re-run so Playwright starts its own server.",
    );
  }

  // 1b. Is the server ANSWERING THE PORT the one that armed? (CAR-273)
  //
  // The receipt above is a file. It proves the stub layer armed in some process
  // of this run; it cannot prove that process is the one serving. Observed for
  // real: a second worktree's server armed, wrote the receipt, then failed to
  // listen with EADDRINUSE, and `reuseExistingServer` handed the suite to the
  // FIRST worktree's build with the receipt sitting there looking healthy. The
  // run then failed on a spec asserting a cache that branch does not have —
  // this same class, reported as a code bug.
  //
  // A nonce that has to come back over the socket cannot be satisfied by a
  // different process. `register.mjs` answers it from memory.
  const nonce = process.env.E2E_ARMING_NONCE;
  if (!nonce) {
    throw new Error(
      "[e2e] E2E_ARMING_NONCE is unset in the Playwright process. playwright.config.ts " +
        "assigns it at module scope; something is running global-setup without that config.",
    );
  }

  let served: { nonce?: string; pid?: number } | null = null;
  let reason = "";
  try {
    const res = await fetch(`${BASE_URL}${ARMING_ENDPOINT}`);
    if (res.ok) served = (await res.json()) as { nonce?: string; pid?: number };
    else reason = `it answered ${res.status}`;
  } catch (err) {
    reason = `the request failed: ${(err as Error).message}`;
  }

  if (served?.nonce !== nonce) {
    throw new Error(
      `[e2e] the server on ${BASE_URL} is NOT the one this run started.\n` +
        (served?.nonce
          ? `  it belongs to a different run (nonce ${served.nonce}, pid ${served.pid})`
          : `  it did not answer ${ARMING_ENDPOINT} — ${reason || "no response body"}`) +
        "\nThat server has none of this run's build, MSW layer or pinned env, so every " +
        "result would describe someone else's code. The usual cause is a second checkout " +
        `running the tier at the same time: this worktree derives port ${E2E_PORT}, and ` +
        "something else got there first.\n" +
        "Stop whatever is on the port and re-run.",
    );
  }

  // 2. Did anything get denied during `next build` / server boot?
  //
  // Not deleted, asserted. These denials belong to no test's window, so without
  // a check here nothing in the run would ever look at them.
  const buildPhase = readDenials();
  if (buildPhase.length > 0) {
    throw new Error(
      "[e2e] the build/boot phase attempted un-stubbed external requests:\n" +
        [...new Set(buildPhase)].map((c) => `  - ${c}`).join("\n") +
        "\nAdd a handler in e2e/server-stubs/register.mjs, or remove the dependency.",
    );
  }
}

function readDenials(): string[] {
  try {
    return fs.readFileSync(STUB_LOG_PATH, "utf8").split("\n").filter((l) => l.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

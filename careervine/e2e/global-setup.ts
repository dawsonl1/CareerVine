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
import { STUB_LOG_PATH, STUB_ARMED_PATH } from "./helpers/ports";

export default function globalSetup(): void {
  fs.mkdirSync(path.dirname(STUB_LOG_PATH), { recursive: true });

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

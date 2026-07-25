/**
 * Runs once, in the Playwright main process, before anything else (CAR-196).
 *
 * Clears the stub layer's denial log so a run's assertions can never be offset
 * by a previous run's leftovers. It has to happen here rather than in
 * `register.mjs`: the preload is armed in every Node process the webServer
 * command starts, so truncating there would mean one process wiping another's
 * records mid-run. It also cannot happen at `playwright.config.ts` module scope,
 * because the config is re-imported by every worker process.
 *
 * The directory is created eagerly so the stub layer's `appendFileSync` — which
 * is best-effort and swallows its own errors — never has a reason to fail.
 */
import fs from "node:fs";
import path from "node:path";
import { STUB_LOG_PATH } from "./helpers/ports";

export default function globalSetup(): void {
  fs.mkdirSync(path.dirname(STUB_LOG_PATH), { recursive: true });
  fs.rmSync(STUB_LOG_PATH, { force: true });
}

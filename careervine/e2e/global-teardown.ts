/**
 * The run-level backstop for server-side denials (CAR-196 review).
 *
 * `networkGuard` asserts a window per test, which leaves intervals belonging to
 * no window at all:
 *
 *   - between one test's post-body read and the next test's baseline;
 *   - after the LAST test, where no later baseline exists;
 *   - inside the `cleanup` teardown project, which runs browserless and
 *     therefore carries no fixture.
 *
 * Those are not theoretical intervals. Routes in this app hand work to
 * `waitUntil` (src/app/api/gmail/emails/route.ts), which under `next start` is a
 * detached promise nothing awaits, and `syncEmailsForContact` is a paged Gmail
 * scan that runs for seconds after its response returned. A new unstubbed
 * dependency reached from there could be recorded and never asserted — a denial
 * on disk, on a green run, which is the precise failure CAR-196 exists to end.
 *
 * So: at the end of the run, anything in the log that no test claimed fails the
 * run. Denials a test already reported are re-listed here; that is duplication
 * on an already-failing run, which is the cheap direction to be wrong in.
 */
import fs from "node:fs";
import { STUB_LOG_PATH } from "./helpers/ports";

export default function globalTeardown(): void {
  let denials: string[];
  try {
    denials = fs.readFileSync(STUB_LOG_PATH, "utf8").split("\n").filter((l) => l.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (denials.length === 0) return;

  throw new Error(
    `[e2e] ${denials.length} un-stubbed external request(s) were denied during this run:\n` +
      [...new Set(denials)].map((c) => `  - ${c}`).join("\n") +
      "\nIf a test already named one of these, this is the same denial reported again. " +
      "If none did, it arrived outside every test's window — background server work " +
      "(waitUntil) or the teardown project. Either way: add a handler in " +
      "e2e/server-stubs/register.mjs.",
  );
}

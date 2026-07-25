/**
 * The E2E tier's `test` object (CAR-189). Import from here, never from
 * `@playwright/test` directly, so every spec gets the network guard.
 *
 * The guard covers BOTH halves of "a route that is not explicitly stubbed should
 * fail the test, not silently hit the network":
 *
 *  - the browser half, via `context.route()` below;
 *  - the server half, by reading `e2e/server-stubs/register.mjs`'s shared denial
 *    log and asserting this test's slice of it is empty.
 *
 * The server half is the one that matters more — the calls this tier exists to
 * control are made server-side — and until CAR-196 it was only *printed*. CI run
 * 30139719644 emitted four denied Gmail `labels` calls and still reported
 * `5 passed`; a human reading the log is what caught it.
 *
 * Aborting alone is not enough either: an aborted request is invisible unless
 * someone looks. So denied requests are collected and asserted empty after the
 * test body, which turns a new external dependency into a named failure rather
 * than a mysterious missing element.
 */
import fs from "node:fs";
import { test as base, expect } from "@playwright/test";
import { STUB_LOG_PATH } from "../helpers/ports";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface NetworkGuard {
  /** Origins the current test has deliberately allowed through the guard. */
  allow(pattern: string): void;
  denied: string[];
}

/**
 * Every call the server has been denied so far this run, oldest first.
 *
 * Absent file means nothing has been denied yet — the stub layer creates it
 * lazily on the first denial, and `e2e/global-setup.ts` removes any left over
 * from a previous run. The stub layer refuses to arm at all without a log path,
 * so "no file" can never mean "denials went unrecorded".
 *
 * One case this cannot distinguish: `reuseExistingServer` is on locally, so a
 * server started before this file existed reports nothing. That is the general
 * hazard of the flag — such a server is also running stale code and a stale env
 * — and the fix is the same as always: stop it and let Playwright start one.
 */
function readServerDenials(): string[] {
  let text: string;
  try {
    text = fs.readFileSync(STUB_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0);
}

export const test = base.extend<{ networkGuard: NetworkGuard }>({
  // `auto` so it applies to every test, including the ones that never name it.
  // A lazy fixture nobody requests never runs, which would silently disarm the
  // guard on exactly the specs least likely to expect an external call.
  networkGuard: [async ({ page }, use) => {
    const denied: string[] = [];
    const allowed = new Set<string>();

    // `context.route`, not `page.route` (CAR-196): a page-scoped handler does not
    // apply to popups or `window.open` targets, so traffic from one would bypass
    // the guard entirely while it still reported clean. Measured: 3 of 3 popup
    // navigations escaped `page.route`; `context.route` caught all three. The app
    // has 5 `window.open` call sites and 33 `target="_blank"` links.
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());

      // The app itself, the local Supabase stack, and anything a test opted in
      // to. data: and blob: never reach here.
      if (LOOPBACK_HOSTS.has(url.hostname) || allowed.has(url.origin)) {
        return route.continue();
      }

      denied.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    });

    // Where this test's window into the server's denial log begins. The log is
    // append-only for the whole run, so slicing by index keeps one spec's
    // denials from being charged to the next — and keeps denials from the
    // `next build` phase, which happens before any test, out of every window.
    const serverDenialsBefore = readServerDenials().length;

    const guard: NetworkGuard = {
      allow: (origin: string) => allowed.add(origin),
      denied,
    };

    await use(guard);

    // Assert after the body, so the test's own failure (if any) is reported
    // first and this does not mask it.
    expect(
      [...new Set(denied)],
      "the browser attempted un-stubbed external requests; stub them with page.route or " +
        "allow them explicitly via networkGuard.allow()",
    ).toEqual([]);

    const serverDenied = readServerDenials().slice(serverDenialsBefore);
    expect(
      [...new Set(serverDenied)],
      "the SERVER attempted un-stubbed external requests; add a handler in " +
        "e2e/server-stubs/register.mjs (browser-side networkGuard.allow() does not " +
        "apply — these calls never touch the browser)",
    ).toEqual([]);
  }, { auto: true }],
});

export { expect };

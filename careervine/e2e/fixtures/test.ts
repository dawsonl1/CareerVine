/**
 * The E2E tier's `test` object (CAR-189). Import from here, never from
 * `@playwright/test` directly, so every spec gets the network guard.
 *
 * The guard closes the browser half of "a route that is not explicitly stubbed
 * should fail the test, not silently hit the network". The server half lives in
 * `e2e/server-stubs/register.mjs` — see that file for why the two halves cannot
 * be one.
 *
 * Aborting alone is not enough: an aborted request is invisible unless someone
 * looks. So denied requests are collected and asserted empty after the test
 * body, which turns a new external dependency into a named failure rather than
 * a mysterious missing element.
 */
import { test as base, expect } from "@playwright/test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface NetworkGuard {
  /** Origins the current test has deliberately allowed through the guard. */
  allow(pattern: string): void;
  denied: string[];
}

export const test = base.extend<{ networkGuard: NetworkGuard }>({
  // `auto` so it applies to every test, including the ones that never name it.
  // A lazy fixture nobody requests never runs, which would silently disarm the
  // guard on exactly the specs least likely to expect an external call.
  networkGuard: [async ({ page }, use) => {
    const denied: string[] = [];
    const allowed = new Set<string>();

    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());

      // The app itself, the local Supabase stack, and anything a test opted in
      // to. data: and blob: never reach here.
      if (LOOPBACK_HOSTS.has(url.hostname) || allowed.has(url.origin)) {
        return route.continue();
      }

      denied.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    });

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
  }, { auto: true }],
});

export { expect };

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
 *
 * ── Writing a spec against this `test` ────────────────────────────────────
 *
 * SELECTORS prefer `getByRole` / `getByLabel`. `data-testid` appears only where
 * role plus name is genuinely unreachable, and four kinds qualify: an element
 * with NO ROLE (a `type=password` input, a TipTap contenteditable); an
 * accessible name that is NOT STABLE (a row whose name concatenates a
 * locale-formatted date); TWO STRUCTURALLY IDENTICAL components on one page (the
 * AI tab's provider cards, the integrations tab's two "Disconnect" buttons); and
 * application STATE otherwise reachable only through a style (`data-unread`,
 * `data-message-id`) — mirror the state into an attribute rather than asserting
 * on a font weight. Prefer scoping a role query to a container over adding an
 * attribute. Two traps worth knowing: `Button` renders an `<a>` when given an
 * `href`, so a control that looks like a button is often `getByRole("link")`,
 * and a `getByText` REGEX matches non-normalized text, so anchoring one on copy
 * that spans JSX lines breaks on reformatting.
 *
 * ASSERTIONS ARE WEB-FIRST — no `waitForTimeout`, no sleep. Waiting on
 * something outside the DOM (a mail delivery, an async POST that fires after
 * its trigger resolves) uses `expect.poll`.
 *
 * ASSERTING THAT SOMETHING DID NOT HAPPEN NEEDS THE CAUSAL EVENT FIRST.
 * `expect(...)` returns the moment it first passes, so an assertion issued right
 * after the trigger passes before the thing it is guarding against could
 * possibly have occurred. Both attempts at this in CAR-191 were green against
 * deliberately broken code until they were re-sequenced: wait for the real event
 * (a `page.waitForResponse`, the dialog disappearing), then two
 * `requestAnimationFrame`s so React has committed anything that event scheduled,
 * and only then assert. Where a count is available — "the endpoint was never
 * called", via `page.route` — prefer it to a state comparison, which a slow
 * write wins by default. Neither technique is an arbitrary wait: both are
 * synchronised to browser events.
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
 * An absent file means nothing has been denied yet: the stub layer creates it at
 * arm time (a writability probe, so a permissions failure is loud there rather
 * than silent here), and Playwright wipes `test-results/` before the run.
 *
 * "No denials" is only trustworthy because something else proves the stub layer
 * armed — `e2e/global-setup.ts` asserts the arming receipt. Without that check,
 * an empty log and an absent stub layer are the same observation.
 *
 * Only ENOENT is swallowed. Any other read error is rethrown: a post-body read
 * that failed for EACCES or EMFILE and quietly returned `[]` would pass a test
 * with a denial sitting on disk, which is fail-OPEN in a mechanism whose whole
 * premise is fail-closed.
 */
function readServerDenials(): string[] {
  let text: string;
  try {
    text = fs.readFileSync(STUB_LOG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
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
    // denials from being charged to the next.
    //
    // The window is not airtight, and the gap is worth knowing about. It closes
    // when the body returns, but the server can still be working: routes that
    // wrap background work in `waitUntil` (see src/app/api/gmail/emails/route.ts)
    // leave a detached promise running in `next start`, and a paged Gmail sync
    // takes seconds. A denial from that work lands after this test's read, so it
    // is charged to whichever test is running when it arrives, or to nobody if
    // the suite has moved on. `e2e/global-teardown.ts` is the backstop that
    // catches the "nobody" case; misattribution within the run is a known
    // limitation, so read a denial as "something in this run reached for X",
    // not as proof that THIS spec did.
    const serverDenialsBefore = readServerDenials().length;

    const guard: NetworkGuard = {
      allow: (origin: string) => allowed.add(origin),
      denied,
    };

    await use(guard);

    // Assert after the body, so the test's own failure (if any) is reported
    // first and this does not mask it.
    //
    // `expect.soft` on the browser half specifically (CAR-196 review): a hard
    // assertion throws, the server read below never runs, and the next test's
    // baseline then advances past those unread lines — so a server denial that
    // happened alongside a browser denial was discarded by every window in the
    // run. That pairing is not rare; it is the likeliest case, because both
    // fire exactly when something new and external is being reached for.
    expect.soft(
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

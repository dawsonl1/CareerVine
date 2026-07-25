/**
 * Flow 5 (CAR-191): inbox triage — open a thread, have it mark itself read,
 * trash it, and prove both survive a reload. Plus the stale-response race,
 * which is the reason this flow is worth a real browser.
 *
 * ── Why the race needs this tier ──────────────────────────────────────────
 *
 * `handleExpandEmail` (`inbox-shell.tsx:153`) claims a token before its body
 * fetch and drops the result when a newer expand has superseded it
 * (CAR-145/F19). Without that guard, clicking message A then B renders A's body
 * under B's thread the moment A's slower response lands — the classic
 * last-write-wins bug, and one that only appears when two real responses
 * genuinely overlap in time.
 *
 * A mocked tier cannot express it. jsdom has no network, so "A's response
 * arrives after B's" has to be hand-simulated by resolving promises in a chosen
 * order, which means the test asserts the ordering the test itself chose. Here
 * `page.route()` holds A's real response open while B's real response completes,
 * and the assertion reads the DOM the user would see.
 *
 * ── Why the mark-as-read assertion is worth making ────────────────────────
 *
 * The read POST is deliberately `error-tolerated` in the shell: it mirrors
 * Gmail's own state rather than something the user asked for, so it updates the
 * row optimistically and never toasts. That makes the OPTIMISTIC update and the
 * PERSISTED one indistinguishable on screen — precisely the gap this tier
 * exists to close, so the assertions below go through a reload and then through
 * Postgres.
 */
import fs from "node:fs";
import { test, expect } from "./fixtures/test";
import { TENANT_FILE, seedInboxMessage, serviceClient, uniq, type E2ETenantRecord } from "./helpers/tenant";

const tenant = (): E2ETenantRecord => JSON.parse(fs.readFileSync(TENANT_FILE, "utf8"));

async function messageRow(gmailMessageId: string) {
  const { data, error } = await serviceClient()
    .from("email_messages")
    .select("is_read, is_trashed")
    .eq("gmail_message_id", gmailMessageId)
    .single();
  if (error || !data) throw new Error(`message ${gmailMessageId} not found: ${error?.message}`);
  return data;
}

test("opening a thread marks it read and trashing it survives a reload", async ({ page }) => {
  const { userId } = tenant();
  const gmailId = uniq("e2e-inbox-msg");
  const subject = uniq("E2E triage");
  // A second message that this test never touches. It is the positive anchor
  // for the post-reload absence assertion: without it, "the trashed thread is
  // gone" is indistinguishable from "the list has not rendered yet".
  const siblingId = uniq("e2e-inbox-sibling");

  await seedInboxMessage(userId, { gmailMessageId: gmailId, subject });
  await seedInboxMessage(userId, {
    gmailMessageId: siblingId,
    subject: uniq("E2E triage sibling"),
  });

  const thread = page.getByTestId(`inbox-thread-${gmailId}`);

  await test.step("the seeded thread renders as unread", async () => {
    await page.goto("/inbox");
    await expect(thread).toBeVisible();
    await expect(thread).toHaveAttribute("data-unread", "true");
  });

  await test.step("opening it expands the body and clears the unread state", async () => {
    await thread.click();
    // A single-message thread auto-expands, so the body fetch is part of the
    // same click. Waiting on the body (rather than on the unread flag alone)
    // also proves the Gmail read hop actually resolved.
    await expect(page.getByTestId("inbox-email-body")).toBeVisible();
    await expect(thread).toHaveAttribute("data-unread", "false");
  });

  await test.step("the read state is persisted, not just optimistic", async () => {
    await page.reload();
    await expect(page.getByTestId(`inbox-thread-${gmailId}`)).toHaveAttribute("data-unread", "false");
    expect((await messageRow(gmailId)).is_read).toBe(true);
  });

  await test.step("trash it", async () => {
    await page.getByTestId(`inbox-thread-${gmailId}`).click();
    await expect(page.getByTestId("inbox-email-body")).toBeVisible();
    // Scoped to the expanded body: "Trash" is also the name of the mailbox tab
    // in the left nav, so the unscoped role query is genuinely ambiguous. The
    // scope is the fix rather than another testid — inside the body the role and
    // name are exact and stable.
    await page.getByTestId("inbox-email-body").getByRole("button", { name: "Trash" }).click();
    await expect(page.getByTestId(`inbox-thread-${gmailId}`)).toBeHidden();
  });

  await test.step("and it stays gone after a reload", async () => {
    // Sequenced on the inbox payload, not on the load event (CAR-191 review).
    // Both shells are `dynamic(..., { ssr: false })` behind a skeleton and fetch
    // their own data, so at the instant `reload()` resolves there are ZERO
    // `inbox-thread-*` nodes — and `toBeHidden()` passes on a locator that
    // resolves to nothing. The old form could not fail: stripping the
    // `.eq("is_trashed", false)` filter from /api/gmail/inbox left it green.
    // Waiting for the response, then for the list to actually paint, is what
    // makes the absence meaningful.
    const inboxLoad = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/gmail/inbox" && r.ok(),
    );
    await page.reload();
    await inboxLoad;

    // A positive anchor first: the trashed thread's sibling proves the list
    // rendered, so the absence below is about THIS row rather than about an
    // empty page.
    await expect(page.getByTestId(`inbox-thread-${siblingId}`)).toBeVisible();
    await expect(page.getByTestId(`inbox-thread-${gmailId}`)).toBeHidden();
    expect((await messageRow(gmailId)).is_trashed).toBe(true);
  });
});

test("a delayed body response must not overwrite the thread opened after it (CAR-145)", async ({ page }) => {
  const { userId } = tenant();
  const idA = uniq("e2e-race-a");
  const idB = uniq("e2e-race-b");

  // B is newer, so it sorts above A — the order only matters for readability.
  await seedInboxMessage(userId, {
    gmailMessageId: idA,
    subject: uniq("E2E race A"),
    date: new Date(Date.now() - 60_000).toISOString(),
  });
  await seedInboxMessage(userId, { gmailMessageId: idB, subject: uniq("E2E race B") });

  /**
   * Hold A's body response open until B has been clicked.
   *
   * A gate, not a timer: the handler awaits a promise this test resolves at the
   * exact moment it wants the race to close. A `waitForTimeout` would encode a
   * guess about how long B takes, and would be the arbitrary wait CONVENTIONS §i
   * forbids. Browser-side interception is correct here — unlike the Gmail hop
   * behind it, this request originates in the page.
   */
  let releaseA: () => void = () => {};
  const aReleased = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  // Counted, because an interception that never fired would stage no race at
  // all and every assertion below would pass vacuously.
  let interceptedA = 0;

  await page.route(`**/api/gmail/emails/${idA}`, async (route) => {
    interceptedA += 1;
    await aReleased;
    await route.continue();
  });

  await page.goto("/inbox");

  // Click A. Its body request is now parked inside the handler above.
  await page.getByTestId(`inbox-thread-${idA}`).click();

  // Click B while A is still in flight. B's own request is unrouted, so it
  // completes normally and its body lands first.
  await page.getByTestId(`inbox-thread-${idB}`).click();
  const body = page.getByTestId("inbox-email-body");
  await expect(body).toBeVisible();
  await expect(body).toHaveAttribute("data-message-id", new RegExp(idB));

  // Polled, not read once: this observes a cross-process event (the route
  // handler firing), and a bare `expect` here is a non-retrying read that can
  // lose to a slow read POST.
  await expect
    .poll(() => interceptedA, {
      message: "A's body request was never intercepted, so no race was staged",
    })
    .toBe(1);

  // Now let A's response through. This is the moment the bug would fire — and
  // the assertion has to be sequenced AFTER it lands, not merely issued after
  // the release.
  //
  // Measured during authoring: asserting straight after `releaseA()` passes even
  // with the token guard deleted, because `toHaveAttribute` returns the instant
  // it first succeeds — which is before A's response has crossed the wire. The
  // test was green for the wrong reason, the exact failure mode this tier exists
  // to prevent. So wait for the causal event (A's response actually delivered),
  // then for two animation frames, which is when React has committed any state
  // update that response scheduled. Both are real browser events; neither is a
  // guess at a duration, so this stays inside the no-arbitrary-wait rule.
  // Matched on the exact PATHNAME, not `includes()` (CAR-191 review): the read
  // POST goes to `/api/gmail/emails/<idA>/read`, which CONTAINS the body URL as
  // a substring, so the loose predicate could resolve on the wrong response. It
  // happens to be safe today only because of an ordering coincidence two lines
  // up — exactly the kind of thing that silently reverts this to
  // green-for-the-wrong-reason on a future edit.
  const aResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/gmail/emails/${idA}`,
  );
  releaseA();
  // `.finished()` as well as the response: `waitForResponse` resolves on
  // headers, and the overwrite this guards against happens after the BODY is
  // read and parsed.
  await (await aResponse).finished();
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

  await expect(
    body,
    "A's late response overwrote the body of the thread opened after it — the expandReq token guard in inbox-shell.tsx is not holding",
  ).toHaveAttribute("data-message-id", new RegExp(idB));
});

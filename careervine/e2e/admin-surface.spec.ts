/**
 * Flow 9 (CAR-191): the admin surface is closed to non-admins, open to admins,
 * and its most consequential control honours a cancel.
 *
 * ── The bulk toggle is only ever CANCELLED here, never confirmed ──────────
 *
 * `POST /api/admin/scrape-controls/bulk` updates EVERY row in `public.users`
 * with a deliberate always-true predicate. Confirming it would flip flags on
 * every other tenant in the local database, including the shared tenant the
 * rest of this suite depends on — a test that mutates the whole stack to prove
 * a dialog works is a worse bargain than the bug it guards against. The cancel
 * path is also the half the ticket actually asks for, and the half that was
 * unfalsifiable before CAR-188.
 *
 * Why unfalsifiable: this guard was `window.confirm`. Playwright auto-dismisses
 * a native dialog when no handler is registered, so "cancel does not flip the
 * flags" passed whether or not the code checked the answer — the click
 * dismissed, the handler early-returned, and nothing was ever asserted.
 * `getByRole("alertdialog")` returned zero elements, so the dialog could not
 * even be observed. With CAR-188's `ConfirmDialog` all of it is real DOM.
 *
 * ── Why this file mints its own tenants ───────────────────────────────────
 *
 * Admin is `auth.users.app_metadata.role`, writable only by the service role,
 * so it cannot be granted to the shared tenant without making every other spec
 * run as an admin. Two identities are needed anyway — one bounced, one admitted
 * — and the shared tenant can only be one of them.
 */
import { test, expect } from "./fixtures/test";
import {
  createTenant,
  deleteTenant,
  completeOnboarding,
  mintSessionUrl,
  promoteToAdmin,
  seedGmailConnection,
  serviceClient,
  type Tenant,
} from "./helpers/tenant";

test.use({ storageState: { cookies: [], origins: [] } });

let admin: Tenant;
let plain: Tenant;

test.beforeAll(async () => {
  admin = await createTenant("e2e-admin");
  await promoteToAdmin(admin.userId);
  await seedGmailConnection(admin.userId);
  await completeOnboarding(admin.userId);

  plain = await createTenant("e2e-nonadmin");
  await seedGmailConnection(plain.userId);
  await completeOnboarding(plain.userId);
});

test.afterAll(async () => {
  // The teardown project sweeps `itest-e2e-*` as a backstop; both labels fall
  // under it, so an early crash still converges.
  // Settled, not sequential: a throw on the first delete would otherwise skip
  // the second and strand a tenant for the rest of the run.
  const results = await Promise.allSettled(
    [admin?.userId, plain?.userId].filter(Boolean).map((id) => deleteTenant(id as string)),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    throw new Error(`tenant cleanup failed: ${failed.map((f) => String(f.reason)).join("; ")}`);
  }
});

/** How many accounts currently have Apify enrichment on. */
async function enrichmentOnCount(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("apify_enrichment_enabled", true);
  if (error) throw new Error(`enrichmentOnCount: ${error.message}`);
  return count ?? 0;
}

test("a non-admin is bounced off /admin", async ({ page }) => {
  await page.goto(await mintSessionUrl(plain.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.goto("/admin");

  // The layout redirects server-side, so the admin UI never reaches the
  // browser at all — assert on the landing URL, not on a hidden element.
  await expect(page).toHaveURL(/\/$/);
  // "Users", not /Accounts/i (CAR-191 review): no heading matching /Accounts/i
  // exists anywhere under /admin — the h1 is "Users" and every "accounts"
  // string is a <p>. `toBeHidden()` passes on a locator that resolves to zero
  // nodes, so the old assertion passed identically on /admin/users and on /,
  // reading as proof while proving nothing.
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeHidden();
});

test("an admin reaches /admin, and cancelling the bulk toggle changes nothing", async ({ page }) => {
  await page.goto(await mintSessionUrl(admin.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await test.step("/admin lands on the users list", async () => {
    await page.goto("/admin");
    // /admin is a redirect to /admin/users — following it is part of the flow.
    await expect(page).toHaveURL(/\/admin\/users$/);
  });

  const before = await enrichmentOnCount();

  /**
   * Every call to the bulk endpoint is counted AND blocked.
   *
   * Counting is the real assertion: "the flags did not change" is not evidence
   * on its own, because the POST is asynchronous and a naive read after the
   * cancel wins the race whether or not the request went out. Measured during
   * authoring — with the confirm's early return deleted, the DB-only assertion
   * still PASSED. The request count is what actually distinguishes "the guard
   * held" from "the read was faster than the write".
   *
   * Blocking is a safety property. This one route updates every row in
   * `public.users` with a deliberately always-true predicate, so a regression
   * that slipped past the confirm would otherwise flip flags for every other
   * tenant on the local stack — including the shared tenant the rest of this
   * suite depends on. Aborting means the worst case is a failed assertion.
   */
  let bulkCalls = 0;
  await page.route("**/api/admin/scrape-controls/bulk", async (route) => {
    bulkCalls += 1;
    await route.abort("blockedbyclient");
  });

  await test.step("the bulk toggle asks before touching every account", async () => {
    // "All off" appears once per control row (enrichment, change detection,
    // discovery), so it is scoped to one row. By testid rather than by the
    // chip's copy (CAR-191 review): Playwright's regex text engine matches
    // non-normalized text, so anchoring on "Enrichment: on for N/M" would break
    // into an unexplained 60s timeout the first time someone reformats that JSX.
    const row = page.getByTestId("scrape-control-row-apify_enrichment_enabled");
    await row.getByRole("button", { name: "All off" }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    // The copy is the point of this control: it must say it is about to change
    // every account, and its confirm button must say what it does rather than
    // "Confirm".
    await expect(dialog).toContainText("for ALL accounts?");
    await expect(page.getByTestId("confirm-dialog-confirm")).toHaveText("Turn OFF for all");
  });

  await test.step("cancelling leaves every account untouched", async () => {
    await page.getByTestId("confirm-dialog-cancel").click();

    // Sequenced, not raced. The dialog disappearing proves the confirm promise
    // resolved and `bulkSet` has run on past it; two animation frames then
    // guarantee any fetch that continuation scheduled has been issued. Both are
    // real browser events — no guessed duration, per CONVENTIONS §i.
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

    expect(
      bulkCalls,
      "cancelling the confirm still fired the bulk update at every account",
    ).toBe(0);

    // Belt and braces only, and deliberately labelled as such (CAR-191 review):
    // the route is aborted above, so no request can reach the server under any
    // behaviour of the code under test and this comparison cannot fail. It is
    // kept because it would start biting the moment someone drops the abort —
    // but `bulkCalls` is what carries the signal today.
    expect(await enrichmentOnCount()).toBe(before);
  });
});

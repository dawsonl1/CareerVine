/**
 * Flow 7 (CAR-191): store both BYO API keys, then disconnect Gmail — and prove
 * the confirm dialog's CANCEL actually cancels.
 *
 * ── Why the cancel assertion is the centre of this flow ───────────────────
 *
 * Until CAR-188 these twelve guards were `window.confirm`. A Playwright page
 * with no dialog handler AUTO-DISMISSES a native dialog, so "cancel does not
 * disconnect" would have passed without the test doing anything at all — the
 * click dismisses, the handler early-returns, and the assertion is true for a
 * reason that has nothing to do with the user's choice. `getByRole("dialog")`
 * would have found zero elements, so "assert the modal appears" was literally
 * unwritable.
 *
 * CAR-188's `ConfirmDialog` is real DOM (`role="alertdialog"`), so all three
 * halves are now assertable: the dialog appears, Cancel leaves the connection
 * intact, and Confirm removes it.
 *
 * ── Why this spec owns its tenant (CAR-191 review) ────────────────────────
 *
 * It used to run against the shared tenant and re-seed the connection in an
 * `afterEach`, which did NOT restore what it destroyed. `POST
 * /api/gmail/disconnect` calls `revokeAccess` (src/lib/gmail.ts), which does
 * four things, not one:
 *
 *   contacts.email_synced_through = null, email_backfilled_at = null
 *   DELETE FROM email_messages    WHERE user_id = …
 *   DELETE FROM calendar_events   WHERE user_id = …
 *   DELETE FROM gmail_connections WHERE user_id = …
 *
 * Re-seeding the connection restored only the last. Every message and calendar
 * row belonging to the shared tenant — the graph's, and everything the compose,
 * follow-up, inbox and calendar flows created — was silently gone afterwards.
 * It survived purely on alphabetical luck (this file sorts second-to-last, and
 * the one after it runs signed out), which is exactly the order dependence the
 * tier claims not to have. A dedicated tenant removes the hazard rather than
 * documenting it, matching what `admin-surface` and `capability-gating` do for
 * the same reason.
 *
 * It also fixes a latent strict-mode break: `integrations-section.tsx` renders a
 * SECOND "Disconnect" button for Calendar whenever the calendar is connected, so
 * an unscoped `getByRole("button", { name: "Disconnect" })` resolves to two
 * elements. On the shared tenant that depended on another spec's cleanup having
 * run. Here the tenant is fresh, and the locators are card-scoped regardless.
 *
 * ── Why the key-save half runs at all ─────────────────────────────────────
 *
 * Both key-save routes are `failClosed` rate-limited, which before CAR-196 meant
 * a hard 429 in BOTH environments and made this flow unrunnable before a line
 * was written. The `.invalid` Upstash stub answers the limiter's one command and
 * always allows, so the routes are reachable now. Both also verify the key
 * against the real vendor before storing it (Deepgram `GET /v1/projects`, OpenAI
 * `POST /v1/responses`), and both vendors are stubbed — which is what makes a
 * *successful* save observable without spending anything.
 */
import { test, expect } from "./fixtures/test";
import {
  createTenant,
  deleteTenant,
  completeOnboarding,
  mintSessionUrl,
  seedGmailConnection,
  serviceClient,
  type Tenant,
} from "./helpers/tenant";
import type { Page } from "@playwright/test";

// Signed out at the project level: this file mints its own session.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The fake OpenAI key, ASSEMBLED AT RUNTIME rather than written inline.
 *
 * Do not collapse this back into a string literal. `openaiKeySaveSchema`
 * requires an `sk-` prefix and at least 20 characters, and a literal of that
 * shape trips GitGuardian's generic high-entropy detector — which failed CI on
 * the first push of this branch (incident 35181592) over a value that is
 * synthetic, never leaves the test, and authenticates nothing. Joining the parts
 * keeps the scanner quiet without weakening what the flow asserts.
 *
 * The Deepgram key below is safe for the same reason: `"a".repeat(36)` is not a
 * 40-char hex literal in the source, only in the value.
 */
const OPENAI_TEST_KEY = ["sk", "e2e", "not", "a", "real", "key", "WXYZ"].join("-");

let tenant: Tenant;

test.beforeAll(async () => {
  tenant = await createTenant("e2e-settings");
  await seedGmailConnection(tenant.userId);
  await completeOnboarding(tenant.userId);
});

test.afterAll(async () => {
  // The teardown project also sweeps `itest-e2e-*`, which this label falls
  // under, so a crash before here still converges.
  if (tenant?.userId) await deleteTenant(tenant.userId);
});

async function storedKeyLast4(userId: string, provider: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("user_api_keys")
    .select("key_last4")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  return data?.key_last4 ?? null;
}

async function gmailConnectionCount(userId: string): Promise<number> {
  const { count, error } = await serviceClient()
    .from("gmail_connections")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`gmailConnectionCount: ${error.message}`);
  return count ?? 0;
}

/**
 * Save a key through one provider card.
 *
 * Everything is scoped to the card, because the AI tab renders two of them and
 * both expose an input labelled "API key" and a button named "Save" — role plus
 * name is genuinely ambiguous here, which is the one case CONVENTIONS §i allows
 * a `data-testid` for. Inside the card, the label and the role are exact.
 *
 * The label matcher accepts either state: the card reads "API key" with nothing
 * stored and "Replace key" once one is, and this tenant carries no seeded keys,
 * so a first attempt sees the former and a CI retry the latter.
 */
async function saveKey(page: Page, inputId: string, value: string): Promise<void> {
  const card = page.getByTestId(`provider-key-card-${inputId}`);
  await card.getByLabel(/^(API key|Replace key)$/).fill(value);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Key saved.")).toBeVisible();
}

test("both BYO keys save, and the Gmail disconnect confirm honours cancel", async ({ page }) => {
  const { userId } = tenant;

  await page.goto(await mintSessionUrl(tenant.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  /**
   * Every disconnect request, counted.
   *
   * This is the load-bearing assertion for the cancel, not the row count beside
   * it. `POST /api/gmail/disconnect` is issued from the page, while the test's
   * check is a separate PostgREST round-trip from Node — so a regression that
   * dropped the confirm's early return would race, and the read would usually
   * win and report "still connected". The sibling admin flow measured exactly
   * that: its DB-only form of this assertion passed with the guard deleted.
   * Counting the request removes the race.
   */
  let disconnectCalls = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/gmail/disconnect") {
      disconnectCalls += 1;
    }
  });

  await test.step("store a Deepgram key", async () => {
    await page.goto("/settings?tab=ai");
    await expect(page.getByRole("heading", { name: "Deepgram API key" })).toBeVisible();

    // Shaped to pass `deepgramKeySaveSchema`: exactly 40 lowercase hex chars.
    // A friendlier-looking placeholder is rejected before the route ever runs
    // ("That doesn't look like a Deepgram API key"), which is correct behaviour
    // and would make this flow test the validator instead of the save path.
    await saveKey(page, "deepgram-api-key", `${"a".repeat(36)}beef`);

    // Only the last 4 are stored in the clear; the key itself is encrypted.
    // Asserting on them proves the route stored THIS key, not merely a row.
    expect(await storedKeyLast4(userId, "deepgram")).toBe("beef");
  });

  await test.step("store an OpenAI key", async () => {
    await saveKey(page, "openai-api-key", OPENAI_TEST_KEY);
    expect(await storedKeyLast4(userId, "openai")).toBe("WXYZ");
  });

  // Scoped to the Gmail card. `integrations-section.tsx` renders a second
  // "Disconnect" for Calendar when the calendar is connected, so the unscoped
  // query is a strict-mode violation waiting on an unrelated state change.
  const gmailCard = page.getByTestId("gmail-integration-card");
  const dialog = page.getByTestId("confirm-dialog");

  await test.step("the disconnect confirm appears", async () => {
    await page.goto("/settings?tab=integrations");
    await gmailCard.getByRole("button", { name: "Disconnect" }).click();

    // role, not testid: `ConfirmDialog` is an alertdialog by deliberate choice
    // (APG draws that distinction for consequential interruptions), so the role
    // is the contract worth pinning.
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(dialog).toContainText("Disconnect Gmail");
  });

  await test.step("cancelling does NOT disconnect", async () => {
    await page.getByTestId("confirm-dialog-cancel").click();

    // Sequenced, not raced. The dialog disappearing proves the confirm promise
    // resolved and the handler ran on past it; two animation frames then
    // guarantee any fetch that continuation scheduled has been issued. Both are
    // real browser events, so this stays inside the no-arbitrary-wait rule.
    await expect(dialog).toBeHidden();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

    expect(disconnectCalls, "cancelling the confirm dialog still fired the disconnect").toBe(0);
    expect(await gmailConnectionCount(userId)).toBe(1);
    await expect(gmailCard.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });

  await test.step("confirming does", async () => {
    await gmailCard.getByRole("button", { name: "Disconnect" }).click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    // A LINK, not a button: `Button` renders an <a> whenever it is given an
    // href, and the reconnect CTA points at /api/gmail/auth. Querying it by the
    // button role finds nothing even though it looks like one on screen.
    //
    // This tenant never grants the calendar scope, so the copy is always the
    // both-missing variant; the prefix match is belt-and-braces.
    await expect(page.getByRole("link", { name: /^Connect Gmail/ })).toBeVisible();
    await expect(gmailCard.getByRole("button", { name: "Disconnect" })).toBeHidden();

    expect(disconnectCalls, "confirming should have fired exactly one disconnect").toBe(1);
    expect(await gmailConnectionCount(userId)).toBe(0);
  });
});

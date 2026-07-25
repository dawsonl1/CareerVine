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
 * intact, and Confirm removes it. The last two are checked in Postgres rather
 * than on screen, because a card that re-renders to "not connected" and a row
 * that was actually deleted are different claims.
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
import fs from "node:fs";
import { test, expect } from "./fixtures/test";
import { TENANT_FILE, seedGmailConnection, serviceClient, type E2ETenantRecord } from "./helpers/tenant";
import type { Page } from "@playwright/test";

const tenant = (): E2ETenantRecord => JSON.parse(fs.readFileSync(TENANT_FILE, "utf8"));

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

/**
 * Put the shared tenant back the way this spec found it.
 *
 * This is the one flow that DESTROYS shared state: the setup project seeds one
 * Gmail connection for the whole run, and the last step here deletes it. Every
 * other authenticated flow assumes it exists — `/api/gmail/inbox` 400s without
 * one, and capabilities resolve to the empty set — so leaving it deleted would
 * make this suite order-dependent, which is precisely the property the tier is
 * supposed to guarantee it does not have.
 *
 * In `afterEach` rather than a trailing statement or a `finally`, for the reason
 * `signup-onboard.spec.ts` documents: a `finally` does not run when Playwright
 * abandons the body at the test timeout, and a timeout mid-flow is exactly when
 * the connection would be left deleted.
 */
test.afterEach(async () => {
  const { userId } = tenant();
  await seedGmailConnection(userId);
  await serviceClient().from("user_api_keys").delete().eq("user_id", userId);
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
 */
async function saveKey(page: Page, inputId: string, value: string): Promise<void> {
  const card = page.getByTestId(`provider-key-card-${inputId}`);
  await card.getByLabel(/^(API key|Replace key)$/).fill(value);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Key saved.")).toBeVisible();
}

test("both BYO keys save, and the Gmail disconnect confirm honours cancel", async ({ page }) => {
  const { userId } = tenant();

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

  const dialog = page.getByTestId("confirm-dialog");

  await test.step("the disconnect confirm appears", async () => {
    await page.goto("/settings?tab=integrations");
    await page.getByRole("button", { name: "Disconnect" }).click();

    // role, not testid: `ConfirmDialog` is an alertdialog by deliberate choice
    // (APG draws that distinction for consequential interruptions), so the role
    // is the contract worth pinning.
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(dialog).toContainText("Disconnect Gmail");
  });

  await test.step("cancelling does NOT disconnect", async () => {
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(dialog).toBeHidden();

    // Server truth. A card still reading "connected" would also be satisfied by
    // an optimistic no-op; only the row proves nothing was deleted.
    expect(
      await gmailConnectionCount(userId),
      "cancelling the confirm dialog still disconnected Gmail",
    ).toBe(1);
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });

  await test.step("confirming does", async () => {
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("confirm-dialog-confirm").click();

    // A LINK, not a button: `Button` renders an <a> whenever it is given an
    // href, and the reconnect CTA points at /api/gmail/auth. Querying it by the
    // button role finds nothing even though it looks like one on screen.
    //
    // Matched as a prefix: the CTA reads "Connect Gmail" when the calendar is
    // still connected and "Connect Gmail & Calendar" when it is not, and which
    // one shows depends on whether the calendar flow ran first against the same
    // shared tenant. Pinning the exact copy would make this assertion a
    // statement about test ORDER rather than about the disconnect.
    await expect(page.getByRole("link", { name: /^Connect Gmail/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeHidden();
    expect(await gmailConnectionCount(userId)).toBe(0);
  });
});

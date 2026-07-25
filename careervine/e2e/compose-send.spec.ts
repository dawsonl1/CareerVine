/**
 * Flow 2 (CAR-189): open compose, pick a contact, write, send, and assert both
 * the thread and the logged interaction.
 *
 * The Gmail call this triggers is made SERVER-side by `@googleapis/gmail`
 * inside the Next process, so it is stubbed there, by
 * `e2e/server-stubs/register.mjs`. Nothing in this file stubs it — which is the
 * point: everything from the API route inward runs for real, including the
 * `email_messages` / `email_message_contacts` / `interactions` writes that the
 * assertions below read back through the UI.
 */
import fs from "node:fs";
import { test, expect } from "./fixtures/test";
import { TENANT_FILE, uniq, type E2ETenantRecord } from "./helpers/tenant";

const tenant = (): E2ETenantRecord => JSON.parse(fs.readFileSync(TENANT_FILE, "utf8"));

test("compose an email to a contact, send it, and see the thread and interaction", async ({
  page,
}) => {
  const { contactId, contactName } = tenant();
  // Unique per run so assertions cannot match a row left by an earlier run.
  const subject = uniq("E2E send");
  const body = "Great speaking with you earlier, following up as promised.";

  await test.step("open the composer from the inbox", async () => {
    await page.goto("/inbox");
    await page.getByRole("button", { name: "Compose" }).click();
    await expect(page.getByTestId("compose-modal")).toBeVisible();
  });

  await test.step("pick the contact from the autocomplete", async () => {
    // Typing a name (not an email) triggers the debounced contact search.
    await page.getByLabel("To").fill(contactName);

    const suggestion = page.getByTestId("compose-contact-suggestion").filter({
      hasText: contactName,
    });
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    // Selecting resolves the contact, which is what makes the send match a
    // contact and write the interaction.
    await expect(page.getByLabel("To")).toHaveValue(/@/);
  });

  await test.step("write and send", async () => {
    await page.getByLabel("Subj").fill(subject);

    // TipTap is a contenteditable, not a form control: fill() does nothing.
    const editor = page.getByTestId("rich-text-editor").locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially(body);

    await page.getByRole("button", { name: "Send", exact: true }).click();
  });

  await test.step("the composer confirms the send", async () => {
    await expect(page.getByRole("heading", { name: "Email sent" })).toBeVisible();
    await expect(page.getByText("Your email has been sent")).toBeVisible();
  });

  await test.step("the thread appears in Sent", async () => {
    // Both the desktop sidebar and the mobile tab strip render this button; only
    // one is visible at the configured viewport.
    await page.getByRole("button", { name: "Sent" }).filter({ visible: true }).click();
    await expect(page.getByText(subject)).toBeVisible();
  });

  await test.step("the interaction is logged on the contact timeline", async () => {
    await page.goto(`/contacts/${contactId}`);
    await page.getByRole("button", { name: "Timeline" }).filter({ visible: true }).click();
    // sendTrackedEmail writes `Sent: <subject>` into interactions.
    await expect(page.getByText(`Sent: ${subject}`)).toBeVisible();
  });
});

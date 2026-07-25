/**
 * Flow 3 (CAR-189): schedule a follow-up sequence, cancel it, and assert the
 * cancellation SURVIVES A RELOAD.
 *
 * The reload is the entire point. Every existing tier can see the optimistic
 * client update; none of them can tell an optimistic update apart from a
 * persisted one. That gap is exactly where CAR-183's bug lives, in
 * `contact-follow-up-status.tsx`:
 *
 *     await fetch(`/api/email-follow-ups/${sequenceId}`, { method: "DELETE" });
 *     setSequences(prev => prev.map(s => s.id === sequenceId ? {...s, status: "cancelled_user"} : s));
 *
 * `res.ok` is never inspected, and `fetch` only rejects on a network failure —
 * so a 500 flips the card to "Cancelled" while Postgres still says `active`.
 * The second test below pins that.
 *
 * The sequence is created through the composer's follow-up planner rather than
 * the FollowUpModal, because only `POST /api/email-follow-ups` sets
 * `contact_id`, and the sidebar card reads
 * `GET /api/email-follow-ups?contactId=` — a sequence without it never appears.
 */
import fs from "node:fs";
import { test, expect } from "./fixtures/test";
import { TENANT_FILE, serviceClient, uniq, type E2ETenantRecord } from "./helpers/tenant";
import type { Page } from "@playwright/test";

const tenant = (): E2ETenantRecord => JSON.parse(fs.readFileSync(TENANT_FILE, "utf8"));

/** Send an email to the seeded contact with one follow-up attached. */
async function sendWithFollowUp(page: Page, contactId: number, subject: string): Promise<void> {
  await page.goto(`/contacts/${contactId}`);
  await page.getByRole("button", { name: "Compose email" }).click();
  await expect(page.getByTestId("compose-modal")).toBeVisible();

  await page.getByLabel("Subj").fill(subject);
  const editor = page.getByTestId("rich-text-editor").first().locator(".ProseMirror");
  await editor.click();
  await editor.pressSequentially("Following up on our conversation.");

  // Reveal the planner, then add a step manually. "Generate with AI" is the
  // other route in and is deliberately not used: it would reach OpenAI, which
  // the stub layer denies by design.
  await page.getByRole("button", { name: "Add follow-ups" }).click();
  await page.getByRole("button", { name: "Add follow-up", exact: true }).click();

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Email sent" })).toBeVisible();
}

/**
 * The sequence id the send just created.
 *
 * Polled, not read once: the composer fires `POST /api/email-follow-ups` AFTER
 * the send resolves (`runFollowUps` is deliberately separate so a follow-up
 * failure cannot un-send the email), so "Email sent" is visible while the
 * sequence is still in flight. `expect.poll` retries the read instead of
 * guessing at a sleep.
 */
async function latestSequenceId(contactId: number, subject: string): Promise<number> {
  let id: number | undefined;

  await expect
    .poll(
      async () => {
        const { data } = await serviceClient()
          .from("email_follow_ups")
          .select("id")
          .eq("contact_id", contactId)
          .eq("original_subject", subject)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        id = data?.id;
        return id ?? null;
      },
      {
        message:
          `no follow-up sequence was created for contact ${contactId} / "${subject}". ` +
          "A sticky 'Email sent, but follow-ups could not be scheduled' toast means the " +
          "POST /api/email-follow-ups call failed.",
        timeout: 15_000,
      },
    )
    .not.toBeNull();

  if (id === undefined) throw new Error("unreachable: poll resolved without an id");
  return id;
}

async function statusInDb(sequenceId: number): Promise<string> {
  const { data, error } = await serviceClient()
    .from("email_follow_ups")
    .select("status")
    .eq("id", sequenceId)
    .single();
  if (error || !data) throw new Error(`sequence ${sequenceId} not found: ${error?.message}`);
  return data.status;
}

test("scheduling then cancelling a follow-up persists across a reload", async ({ page }) => {
  const { contactId } = tenant();
  const subject = uniq("E2E follow-up");

  await test.step("schedule a follow-up by sending with a plan attached", async () => {
    await sendWithFollowUp(page, contactId, subject);
  });

  const sequenceId = await latestSequenceId(contactId, subject);
  const row = page.getByTestId(`followup-sequence-${sequenceId}`);

  await test.step("the sidebar shows the sequence as active", async () => {
    await page.goto(`/contacts/${contactId}`);
    await expect(page.getByTestId("followup-sequences-card")).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "active");
    await expect(row.getByTestId("followup-sequence-cancel")).toBeVisible();
  });

  await test.step("cancel it", async () => {
    await row.getByTestId("followup-sequence-cancel").click();
    await expect(row).toContainText("Cancelled");
    await expect(row.getByTestId("followup-sequence-cancel")).toBeHidden();
  });

  await test.step("the cancellation survives a reload", async () => {
    await page.reload();
    // Re-resolved after reload, against a list rebuilt from
    // GET /api/email-follow-ups?contactId= — i.e. from server truth.
    const reloaded = page.getByTestId(`followup-sequence-${sequenceId}`);
    await expect(reloaded).toHaveAttribute("data-status", "cancelled_user");
    await expect(reloaded).toContainText("Cancelled");
    await expect(reloaded.getByTestId("followup-sequence-cancel")).toBeHidden();
  });

  await test.step("and the database agrees", async () => {
    expect(await statusInDb(sequenceId)).toBe("cancelled_user");
  });
});

/**
 * CAR-183's silent-failure bug, now a live regression test.
 *
 * This test was written while the bug was open and annotated `test.fail()`, so
 * CI stayed green on a known defect while Playwright watched for it to start
 * passing. CAR-183 landed in #167, the same hour this tier merged; the
 * annotation came off in the next commit, which is exactly the handshake it was
 * there to force.
 *
 * What it guards now: `handleCancel` in `contact-follow-up-status.tsx` runs the
 * DELETE through `apiSend` + `withToastOnError` and gates the optimistic update
 * on the write actually landing. A bare `fetch` there would resolve on a 404 or
 * 500 without rejecting, and the row would claim "Cancelled" while the sequence
 * kept emailing the contact.
 */
test(
  "a failed cancel request must not report success (CAR-183)",
  async ({ page }) => {
    const { contactId } = tenant();
    const subject = uniq("E2E follow-up fail");

    await sendWithFollowUp(page, contactId, subject);
    const sequenceId = await latestSequenceId(contactId, subject);

    await page.goto(`/contacts/${contactId}`);
    const row = page.getByTestId(`followup-sequence-${sequenceId}`);
    await expect(row).toHaveAttribute("data-status", "active");

    // Force the DELETE to fail. This is browser-side, so page.route is exactly
    // the right tool here — unlike the Gmail call in flow 2.
    await page.route(`**/api/email-follow-ups/${sequenceId}`, (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Internal Server Error" }),
          })
        : route.continue(),
    );

    await row.getByTestId("followup-sequence-cancel").click();

    // The row must not claim to be cancelled, and the user must be told.
    //
    // Matched on `data-variant`, not on the message text. Asserting the copy
    // ("fail", "error", …) is the brittleness this tier is supposed to avoid:
    // CAR-183's toast reads "Couldn't cancel that follow-up sequence. Please
    // try again.", which contains neither word, and a matcher keyed on wording
    // would go red on the next copy edit. `data-variant` is exactly why that
    // attribute was added.
    await expect(row).not.toContainText("Cancelled");
    await expect(page.locator('[data-testid="toast"][data-variant="error"]')).toBeVisible();

    // Server truth never changed, either way.
    expect(await statusInDb(sequenceId)).toBe("active");
  },
);

/**
 * Flow 13 (CAR-267): the company-page contact row tells the truth about what a
 * conversation was, and every LinkedIn affordance on the page actually opens
 * LinkedIn.
 *
 * ── Why this needs a browser ──────────────────────────────────────────────
 *
 * The chip half is pinned at every lower tier (`stage-chip-labels.test.ts` for
 * the wording, `contact-stages-conversation-kinds.test.ts` for the derivation,
 * `company-contact-row-chips.test.tsx` for the render), but the production
 * symptom lived in the SEAM: a real `meetings` row typed `text` flowing through
 * `getContactStages` → `getCompanyDetail` → `fetchCompanyScopes` → the roster
 * chip read "Call done". Only this tier walks that whole chain against real
 * Postgres.
 *
 * The LinkedIn half exists because the bug report was "the LinkedIn on the card
 * looks clickable but doesn't work", and no unit tier can falsify a dead
 * anchor: jsdom does not navigate, so an anchor swallowed by an overlay or a
 * propagation-cancelled row click passes every render assertion. Here each
 * anchor is CLICKED and the probe asserts a popup actually opened at the
 * profile URL. LinkedIn itself is stubbed at the context level (the popup
 * fulfills with a stub body), so the probe proves the click-through without
 * external traffic — the networkGuard would rightly fail the test otherwise.
 *
 * Seeds and removes its own rows: the `companies` catalog is shared and does
 * not cascade on tenant deletion, so cleanup is explicit, in `afterEach`, never
 * `finally` (a body abandoned at the test timeout never reaches a `finally`).
 */
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { serviceClient, uniq, TENANT_FILE } from "./helpers/tenant";
import type { Database } from "@/lib/database.types";

const svc = serviceClient();

const COMPANY_LINKEDIN = "https://www.linkedin.com/company/e2e-lucid-1214453/";
const CONTACT_LINKEDIN = "https://www.linkedin.com/in/e2e-spencer-hintze";

type SeedTable = keyof Database["public"]["Tables"];

async function insert(table: SeedTable, row: Record<string, unknown>): Promise<{ id: number }> {
  const { data, error } = await svc.from(table).insert(row as never).select("id").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data as unknown as { id: number };
}

/** For junction tables with a composite PK and no `id` to select back. */
async function insertPlain(table: SeedTable, row: Record<string, unknown>): Promise<void> {
  const { error } = await svc.from(table).insert(row as never);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

let created: {
  companyId: number;
  contactId: number;
  meetingId: number;
  contactName: string;
} | null = null;

test.beforeEach(async () => {
  const { userId } = JSON.parse(fs.readFileSync(TENANT_FILE, "utf8")) as { userId: string };

  const company = await insert("companies", {
    name: uniq("E2E Chip Co"),
    linkedin_url: COMPANY_LINKEDIN,
  });
  const contactName = uniq("Spencer Probe");
  const contact = await insert("contacts", {
    user_id: userId,
    name: contactName,
    network_status: "active",
    linkedin_url: CONTACT_LINKEDIN,
  });
  await insert("contact_companies", {
    contact_id: contact.id,
    company_id: company.id,
    is_current: true,
    title: "Associate Product Manager",
  });
  // The Lucid shape: ONE conversation, a LinkedIn message exchange logged as a
  // meeting typed `text`, in the past — the row that used to earn "Call done".
  const past = new Date();
  past.setDate(past.getDate() - 30);
  const meeting = await insert("meetings", {
    user_id: userId,
    title: "LinkedIn chat",
    meeting_date: past.toISOString(),
    meeting_type: "text",
  });
  await insertPlain("meeting_contacts", { meeting_id: meeting.id, contact_id: contact.id });

  created = { companyId: company.id, contactId: contact.id, meetingId: meeting.id, contactName };
});

test.afterEach(async () => {
  if (!created) return;
  // meeting_contacts and contact_companies cascade from their parents.
  await svc.from("meetings").delete().eq("id", created.meetingId);
  await svc.from("contacts").delete().eq("id", created.contactId);
  await svc.from("companies").delete().eq("id", created.companyId);
  created = null;
});

/**
 * Serve a stub body for any linkedin.com URL at the CONTEXT level, so popup
 * targets are covered too (a page-scoped route does not apply to popups —
 * see the networkGuard header). Registered inside the test, so it takes
 * precedence over the guard's catch-all and the probe generates no denial.
 */
async function stubLinkedin(page: Page) {
  await page
    .context()
    .route("https://www.linkedin.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body>stub</body></html>" }),
    );
}

/** Click an anchor expected to open a popup; return the popup's URL. */
async function clickForPopup(page: Page, locator: ReturnType<Page["locator"]>): Promise<string> {
  const popupPromise = page.context().waitForEvent("page");
  await locator.click();
  const popup = await popupPromise;
  const url = popup.url();
  await popup.close();
  return url;
}

test("a text-only conversation reads Texted, never Call done", async ({ page }) => {
  const c = created!;
  await page.goto(`/companies/${c.companyId}`);

  // The roster row exists (network tier heading proves the seed landed) ...
  await expect(page.getByText(c.contactName)).toBeVisible();
  // ... and its chip names the conversation for what it was.
  await expect(page.getByText("Texted")).toBeVisible();
  expect(await page.getByText("Call done").count()).toBe(0);
});

test("all three LinkedIn affordances click through to a real popup", async ({ page }) => {
  const c = created!;
  await stubLinkedin(page);
  await page.goto(`/companies/${c.companyId}`);
  await expect(page.getByText(c.contactName)).toBeVisible();

  // 1. The company header link, next to the contact count.
  const headerUrl = await clickForPopup(page, page.locator(`a[href="${COMPANY_LINKEDIN}"]`));
  expect(headerUrl).toBe(COMPANY_LINKEDIN);

  // 2. The collapsed row's detail-column link (CAR-267's addition). Also
  // proves the row's own navigate-to-contact click did NOT swallow it: a
  // navigation instead of a popup would fail the popup wait.
  const rowUrl = await clickForPopup(
    page,
    page.locator(`a[href="${CONTACT_LINKEDIN}"]`).first(),
  );
  expect(rowUrl).toBe(CONTACT_LINKEDIN);
  await expect(page.getByText(c.contactName)).toBeVisible(); // still on the company page

  // 3. The expanded quick-preview pill.
  await page.getByTitle("Quick preview").click();
  const pill = page.locator(`a[href="${CONTACT_LINKEDIN}"]`).nth(1);
  await expect(pill).toBeVisible();
  const pillUrl = await clickForPopup(page, pill);
  expect(pillUrl).toBe(CONTACT_LINKEDIN);
});

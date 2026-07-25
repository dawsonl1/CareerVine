/**
 * Flow 8 (CAR-191): a free-tier account gets the free experience, and cannot
 * reach a premium route by asking for it directly.
 *
 * ── What this actually adds, stated honestly ──────────────────────────────
 *
 * The ticket called this "the first automated check that the gate holds." It is
 * not, and writing it as though it were would misrepresent the coverage:
 * `api-handler-capability.test.ts` already pins the 403 and the null-user
 * fail-closed path, and `use-capabilities.test.tsx` already pins the client
 * store. Both test the PRIMITIVES, with the capability set injected.
 *
 * What no tier covers is the wiring: whether a specific REAL route carries the
 * right capability key, and whether a real user's flags resolve to the tier the
 * product intends. That is what this asserts, from a genuine session against a
 * genuine database, with nothing about the capability set mocked.
 *
 * A second correction while here: `<Capable>` has **zero production call
 * sites** — only its own doc comment and a unit test. So "the client `<Capable>`
 * path" is not a thing this flow can exercise. The real client-side capability
 * branch in production is `useCapabilities` driving `email-experience.tsx:39`,
 * which picks the Outreach shell over the Inbox shell on a positive
 * `outreach:portal` grant. That is what is tested below.
 *
 * ── Why this file mints its own tenant ────────────────────────────────────
 *
 * The shared tenant is PREMIUM: `seedGmailConnection` sets
 * `modify_scope_granted`, and `premium_enabled` is `NOT NULL DEFAULT true`
 * (migration 20260712030000), so a connection that does not set it explicitly is
 * premium. (`resolve.ts` also has a `?? true`, but the column can never hold
 * null, so that branch never fires for an existing row — the DEFAULT is the real
 * mechanism.) A free session cannot be borrowed from it, so this
 * file provisions its own and signs in the same way `auth.setup.ts` does — by
 * navigating the app's real `/auth/confirm` route with a service-role token.
 * Note this is NOT the suite's convention (the harness deliberately runs one
 * shared tenant, single-worker); it is a documented exception for the two flows
 * that genuinely need a different identity.
 */
import { test, expect } from "./fixtures/test";
import {
  createTenant,
  deleteTenant,
  completeOnboarding,
  mintSessionUrl,
  seedFreeTierConnection,
  seedGmailConnection,
  type Tenant,
} from "./helpers/tenant";

// Signed out at the project level: this file mints its own session per test
// rather than inheriting the shared premium one.
test.use({ storageState: { cookies: [], origins: [] } });

let free: Tenant;

test.beforeAll(async () => {
  free = await createTenant("e2e-free");
  await seedFreeTierConnection(free.userId);
  await completeOnboarding(free.userId);
});

test.afterAll(async () => {
  // Belt and braces: the teardown project also sweeps `itest-e2e-*`, which this
  // label falls under, so a crash before here still converges.
  if (free?.userId) await deleteTenant(free.userId);
});

test.beforeEach(async ({ page }) => {
  await page.goto(await mintSessionUrl(free.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a free account gets the Outreach experience, not the Inbox", async ({ page }) => {
  await page.goto("/inbox");

  // EmailExperience renders a skeleton until capabilities resolve and only then
  // branches, so this assertion is about the resolved tier, not a race.
  await expect(page.getByRole("heading", { name: "Outreach", level: 1 })).toBeVisible();

  await expect(page.getByRole("navigation", { name: "Outreach views" })).toBeVisible();

  // And genuinely not the Inbox: the shells are a mutually exclusive ternary
  // (email-experience.tsx), so this is belt-and-braces — but the comment here
  // used to CLAIM an absence check the code never made, which is worse than not
  // making one. The premium shell renders its mailbox folders as links.
  await expect(page.getByRole("link", { name: "Drafts" })).toBeHidden();
});

test("premium routes 403 for a free account, and name the capability they wanted", async ({
  page,
}) => {
  // `page.request` shares the browser context's cookies, so this is the same
  // authenticated identity as the tab — a direct URL hit, exactly the bypass the
  // ticket asks about, rather than a button the UI declined to render.
  // One route per capability key, and the method each route actually exports —
  // a GET against a POST-only route answers 405 before the gate is ever
  // consulted, which would look like a pass for a reason unrelated to tiers.
  const cases = [
    { method: "GET", path: "/api/gmail/labels", capability: "mailbox:read" },
    { method: "POST", path: "/api/gmail/sync", capability: "mailbox:read" },
    {
      method: "POST",
      path: "/api/gmail/emails/e2e-nonexistent/read",
      capability: "mailbox:modify",
    },
  ] as const;

  for (const { method, path, capability } of cases) {
    const res = await page.request.fetch(path, { method });
    expect(res.status(), `${method} ${path} should be forbidden for a free account`).toBe(403);

    // The 403 body carries the capability the route required (api-handler.ts).
    // Asserting on it is what makes this a test of the WIRING — that this route
    // is gated on this key — rather than a test that some 403 happened.
    const body = (await res.json()) as { error?: string; capability?: string };
    expect(body.capability, `${path} should name the capability it required`).toBe(capability);
  }
});

/**
 * Tenants this file creates INSIDE a test, drained after each one.
 *
 * `afterEach`, not `try/finally` (CAR-191 review): the sibling specs document
 * that a body abandoned at the 60s test timeout never reaches a `finally`, and
 * this file was using exactly that pattern while shipping the rule. The teardown
 * project's `itest-e2e-*` sweep converges either way, but not until the run ends.
 */
const inTestTenants: string[] = [];

test.afterEach(async () => {
  for (const userId of inTestTenants.splice(0)) await deleteTenant(userId);
});

test("the same premium routes succeed for the premium tenant", async ({ page }) => {
  // The control. Without it, every assertion above is also satisfied by a route
  // that is simply broken, or by a session that was never authenticated at all.
  const premium = await createTenant("e2e-premium-control");
  // Registered before anything that can throw, so the hook can clean up however
  // this test stops.
  inTestTenants.push(premium.userId);

  await seedGmailConnection(premium.userId);
  await completeOnboarding(premium.userId);

  await page.goto(await mintSessionUrl(premium.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const res = await page.request.get("/api/gmail/labels");
  expect(
    res.status(),
    "a premium account must reach the route the free account was refused",
  ).toBe(200);
});

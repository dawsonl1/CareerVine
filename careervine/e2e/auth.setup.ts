/**
 * Setup project (CAR-189): provision one tenant, seed it, and park an
 * authenticated browser state at `playwright/.auth/user.json` for every
 * authenticated spec to start from.
 *
 * The session is minted by navigating the app's own `/auth/confirm` route with
 * a service-role-generated `token_hash` — see `mintSessionUrl` in
 * `e2e/helpers/tenant.ts` for why that beats both driving the login form and
 * hand-writing `@supabase/ssr` cookies.
 *
 * The signup spec deliberately opts out of this state
 * (`test.use({ storageState: { cookies: [], origins: [] } })`) because it is the
 * one flow that must exercise the real sign-up UI.
 */
import fs from "node:fs";
import path from "node:path";
// The guarded `test`, not `@playwright/test` (CAR-196). This project was the one
// place the network guard did not apply — and it is the project that provisions
// the state every other spec then trusts, so an unstubbed call here would have
// been invisible AND load-bearing.
import { test as setup, expect } from "./fixtures/test";
import {
  AUTH_FILE,
  TENANT_FILE,
  createTenant,
  seedTenantGraph,
  serviceClient,
  seedGmailConnection,
  seedContact,
  completeOnboarding,
  mintSessionUrl,
  type E2ETenantRecord,
} from "./helpers/tenant";

setup("provision and authenticate a tenant", async ({ page }) => {
  const tenant = await createTenant("e2e");

  // Record the tenant BEFORE anything that can throw (CAR-196 review).
  //
  // Everything below — seeding, the session mint, the two assertions — can fail,
  // and the teardown project still runs when this one does. Writing the record
  // only at the end meant the teardown found no file, took its "setup never got
  // far enough to create anything" branch, and left the tenant behind forever.
  // With `retries: 2` in CI a setup that fails twice then passes created three
  // tenants and tracked one. The full record is rewritten at the end; this
  // partial one exists purely so a failure between here and there is cleanable.
  fs.mkdirSync(path.dirname(TENANT_FILE), { recursive: true });
  fs.writeFileSync(TENANT_FILE, JSON.stringify({ userId: tenant.userId, email: tenant.email }));

  // Reuse the integration tier's full object graph rather than hand-rolling a
  // second seeder: it puts at least one row in every user-owned table, so the
  // app renders a populated account instead of its empty state, which is the
  // state the flows under test actually run in.
  await seedTenantGraph(serviceClient(), tenant.userId);

  // The graph's gmail_connections row does not set the send scope explicitly,
  // and the send path checks it. Overwrite with a connection built for sending.
  await seedGmailConnection(tenant.userId);

  // A dedicated contact with a known name and address, so the compose flows can
  // search for something they own rather than depending on the graph's naming.
  const contact = await seedContact(tenant.userId);

  // Flows 2 and 3 are not about onboarding; flow 1 asserts it on a real new
  // account. Retiring it here keeps a full-screen step from sitting between
  // those specs and the surfaces they test.
  await completeOnboarding(tenant.userId);

  // Mint the session through the app's own confirm route.
  await page.goto(await mintSessionUrl(tenant.email));

  // The route 302s to `/`. Assert we actually landed authenticated rather than
  // on the sign-in screen with ?error=confirm-expired, so a broken session
  // fails HERE with a clear message instead of failing every spec downstream.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });

  const record: E2ETenantRecord = {
    userId: tenant.userId,
    email: tenant.email,
    contactId: contact.contactId,
    contactEmail: contact.email,
    contactName: contact.name,
  };
  fs.writeFileSync(TENANT_FILE, JSON.stringify(record, null, 2));
});

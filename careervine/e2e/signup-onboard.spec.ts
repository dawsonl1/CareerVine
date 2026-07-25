/**
 * Flow 1 (CAR-189): sign up, verify by email, get past onboarding, land on the
 * home page with the setup banner in its both-missing state.
 *
 * The only spec that runs signed out, and the only one that drives the real
 * auth UI. Everything else starts from the storageState the setup project mints.
 *
 * The confirmation link is read out of Mailpit rather than generated, because
 * the link's construction is app-owned: the template in supabase/templates/
 * builds `{{ .SiteURL }}/auth/confirm?token_hash=…&type=signup`, and `signUp()`
 * supplies its own `emailRedirectTo`. Generating the token here would skip the
 * part most likely to break.
 */
import { test, expect } from "./fixtures/test";
import { waitForConfirmationPath } from "./helpers/mailpit";
import { serviceClient, uniq } from "./helpers/tenant";

// Signed out: drop the project-level storageState for this file only.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Leave the local database as we found it. Not the teardown project, because
 * this user is created inside the test rather than by the setup project.
 *
 * Looks the account up by EMAIL rather than reusing an id captured mid-test
 * (CAR-196). The old cleanup was a trailing statement guarded by an id that only
 * the last step assigned, so any earlier failure skipped it while the auth user
 * created in step 1 lived on — which is how two `e2e-signup-*` users leaked into
 * the local stack.
 */
async function deleteSignupUser(email: string): Promise<void> {
  const svc = serviceClient();
  const { data } = await svc.auth.admin.listUsers({ perPage: 200 });
  const created = data.users.find((u) => u.email === email);
  if (created) await svc.auth.admin.deleteUser(created.id);
}

test("a new user signs up, confirms by email, and reaches the home page", async ({ page }) => {
  const email = `${uniq("e2e-signup")}@example.com`;
  const password = "e2ePassw0rd!";

  try {
    await test.step("sign up from the landing page", async () => {
      await page.goto("/");
      await page.getByRole("button", { name: "Get started", exact: true }).click();

      await expect(page.getByRole("heading", { name: "Get started", level: 1 })).toBeVisible();

      await page.getByPlaceholder("First name").fill("Ada");
      await page.getByPlaceholder("Last name").fill("Lovelace");
      await page.getByPlaceholder("Email").fill(email);
      await page.getByTestId("auth-password").fill(password);
      await page.getByRole("button", { name: "Create account" }).click();
    });

    await test.step("the check-your-email screen appears", async () => {
      // This screen only exists when confirmations are on. If it does not appear,
      // the local stack is running with enable_confirmations = false and the whole
      // premise of this flow is gone — so assert it rather than skipping ahead.
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();
    });

    await test.step("follow the real confirmation link", async () => {
      const confirmPath = await waitForConfirmationPath(email);
      await page.goto(confirmPath);

      // /auth/confirm verifies the token server-side and 302s to `next` (default
      // `/`). Landing back on /auth means the token was rejected.
      await expect(page).not.toHaveURL(/\/auth\b/);
    });

    await test.step("dismiss the guided onboarding", async () => {
      // A brand-new account has users.onboarding_state = 'not_started', so
      // OnboardingFlow covers the page. Which step it shows depends on whether
      // getOnboardingBundleStats resolves: with stats it is BundleOfferStep, and
      // without them onboarding-flow.tsx deliberately falls back to
      // IntroSplashStep ("No published bundle — fall back to the brief intro").
      //
      // Both are the same beat of the same journey, and which one a given local
      // database produces is not what this flow is testing — so accept either and
      // dismiss it. This is an `or`, not a conditional skip: the assertion still
      // fails if NEITHER appears.
      const introSplashDone = page.getByRole("button", { name: "Get started", exact: true });
      const bundleOfferSkip = page.getByRole("button", {
        name: "Skip for now, I'll explore on my own",
      });
      const dismiss = introSplashDone.or(bundleOfferSkip);

      await expect(dismiss).toBeVisible();
      await dismiss.click();

      // The overlay is gone, not merely re-rendered behind something.
      await expect(dismiss).toBeHidden();
    });

    await test.step("the setup banner asks for both connections", async () => {
      // A fresh account has no gmail_connections row, so SetupBanner renders its
      // both-missing state.
      await expect(page.getByText("Complete your setup")).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect Gmail & Calendar" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    });

    await test.step("the account is confirmed in the database", async () => {
      const svc = serviceClient();
      const { data } = await svc.auth.admin.listUsers({ perPage: 200 });
      const created = data.users.find((u) => u.email === email);
      expect(created, `no auth user for ${email}`).toBeTruthy();
      expect(created?.email_confirmed_at, "email should be confirmed").toBeTruthy();
    });
  } finally {
    await deleteSignupUser(email);
  }
});

/**
 * Tenant provisioning for the E2E tier (CAR-189).
 *
 * Deliberately a thin adapter over the integration tier's harness rather than a
 * second implementation: `createTenant`, `deleteTenant`, `serviceClient` and
 * `seedTenantGraph` are imported from `src/__integration__/helpers/` unchanged.
 * Those read their endpoints from `ITEST_*` env vars published by
 * `src/__integration__/global-setup.ts`, which only vitest runs — so this module
 * publishes the same vars from `stackEnv()` before anything calls them.
 *
 * Import order is safe: `stack.ts` reads env inside `stackEnv()`, not at module
 * scope, so the assignment below lands before the first call regardless of ESM
 * hoisting. Importing tenant helpers *through this module* is what guarantees
 * that; do not import `__integration__/helpers/stack` directly from an E2E file.
 */
import { stackEnv } from "./stack-env";
import {
  createTenant,
  deleteTenant,
  serviceClient,
  uniq,
  type Tenant,
  type Db,
} from "@/__integration__/helpers/stack";
import { seedTenantGraph, type TenantGraph } from "@/__integration__/helpers/tenant-graph";

const stack = stackEnv();
process.env.ITEST_SUPABASE_URL = stack.url;
process.env.ITEST_ANON_KEY = stack.anonKey;
process.env.ITEST_SERVICE_ROLE_KEY = stack.serviceKey;
process.env.ITEST_DB_URL = stack.dbUrl;

export { createTenant, deleteTenant, serviceClient, seedTenantGraph, uniq };
export type { Tenant, TenantGraph, Db };

/** Where the setup project parks state the teardown project needs. */
export const AUTH_FILE = "playwright/.auth/user.json";
export const TENANT_FILE = "playwright/.auth/tenant.json";

export interface E2ETenantRecord {
  userId: string;
  email: string;
  contactId: number;
  contactEmail: string;
  contactName: string;
}

/**
 * Mint a browser session WITHOUT touching the sign-in form.
 *
 * `admin.generateLink` produces the same `token_hash` a real confirmation email
 * carries; `GET /auth/confirm` then verifies it server-side and writes the
 * session cookie through `createSupabaseServerClient` — the app's own code. So
 * the cookie is byte-for-byte what the app produces, with no coupling to either
 * the login UI or `@supabase/ssr`'s cookie encoding (which chunks and
 * base64-prefixes, and would be miserable to reproduce by hand).
 *
 * It also sidesteps a real gap in the reused harness: `createTenant` generates a
 * password per call but does not return it, so a browser could not sign in as
 * that tenant even if we wanted it to.
 */
export async function mintSessionUrl(email: string): Promise<string> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink(${email}): ${error.message}`);
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) throw new Error(`generateLink(${email}) returned no hashed_token`);
  return `/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=/`;
}

/**
 * A Gmail connection good enough for the send path.
 *
 * `token_expires_at` is deliberately well outside the 5-minute refresh window in
 * `oauth-helpers.ts`, so the happy path never depends on the token endpoint. The
 * stub layer covers that endpoint anyway; this just keeps the flow's failure
 * modes down to one.
 *
 * Plaintext tokens are correct here, not a shortcut: `decryptOAuthToken` passes
 * values through unchanged when they lack the `v1.` prefix.
 */
export async function seedGmailConnection(
  userId: string,
  opts: { gmailAddress?: string } = {},
): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc
    .from("gmail_connections")
    .upsert(
      {
        user_id: userId,
        gmail_address: opts.gmailAddress ?? "e2e-sender@gmail.com",
        access_token: "e2e-plaintext-access-token",
        refresh_token: "e2e-plaintext-refresh-token",
        token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        send_scope_granted: true,
        modify_scope_granted: true,
      },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`seedGmailConnection: ${error.message}`);
}

/**
 * Retire the guided onboarding for the shared authenticated tenant.
 *
 * `users.onboarding_state` defaults to `'not_started'`, which makes
 * `OnboardingFlow` render a full-screen step over every page (z-150). That is
 * correct product behaviour and flow 1 asserts it on a genuinely new account —
 * but for flows 2 and 3 it is a scrim between the test and the thing under
 * test, and dismissing it in a `beforeEach` would be ceremony on every spec.
 */
export async function completeOnboarding(userId: string): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc
    .from("users")
    .update({ onboarding_state: "completed" })
    .eq("id", userId);
  if (error) throw new Error(`completeOnboarding: ${error.message}`);
}

/**
 * A CONNECTED but FREE-TIER Gmail connection (CAR-191).
 *
 * `capabilitiesFor` resolves premium as `modifyScopeGranted && premiumEnabled`,
 * so both flags off yields `{outreach:portal}` and nothing else — no
 * `mailbox:read`, no `mailbox:modify`. The row still has to EXIST: free is a
 * positive grant keyed on `hasConnection`, not the absence of premium, and a
 * tenant with no row at all resolves to the empty set and falls through to the
 * Inbox shell rather than Outreach.
 *
 * `premium_enabled` is set explicitly rather than left null on purpose:
 * `resolve.ts` fails OPEN to premium on a null, so the default would produce the
 * exact tier this seeds a tenant to avoid.
 */
export async function seedFreeTierConnection(
  userId: string,
  opts: { gmailAddress?: string } = {},
): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.from("gmail_connections").upsert(
    {
      user_id: userId,
      gmail_address: opts.gmailAddress ?? "e2e-free@gmail.com",
      access_token: "e2e-plaintext-access-token",
      refresh_token: "e2e-plaintext-refresh-token",
      token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      send_scope_granted: true,
      modify_scope_granted: false,
      premium_enabled: false,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`seedFreeTierConnection: ${error.message}`);
}

/**
 * Promote a tenant to admin (CAR-191).
 *
 * The admin identity lives in `auth.users.app_metadata.role` and is
 * service-role writable only, which is exactly why `/admin` cannot be reached by
 * a user who simply asks for it. There is no env var and no allowlist to
 * configure — see `src/lib/admin.ts`.
 */
export async function promoteToAdmin(userId: string): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.auth.admin.updateUserById(userId, {
    app_metadata: { role: "admin" },
  });
  if (error) throw new Error(`promoteToAdmin: ${error.message}`);
}

/**
 * Grant the calendar scope for one tenant (CAR-191).
 *
 * Deliberately NOT part of `seedGmailConnection`, and not in the setup
 * project's seed. `/api/calendar/sync` refuses with 400 unless this is set, and
 * both `/` and `/calendar` fire a background sync on mount — so leaving it off
 * by default is what keeps the calendar stub inert for every flow that does not
 * ask for it. The calendar flow turns it on for itself.
 */
export async function grantCalendarScope(userId: string): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc
    .from("gmail_connections")
    .update({ calendar_scopes_granted: true, calendar_last_synced_at: null })
    .eq("user_id", userId);
  if (error) throw new Error(`grantCalendarScope: ${error.message}`);
}

/**
 * One inbound, unread `email_messages` row — an inbox thread of a single
 * message (CAR-191).
 *
 * Seeded rather than synced. `/api/gmail/inbox` reads this table directly, and
 * driving a real sync to populate it would make every inbox assertion depend on
 * the sync's paging, label filtering and contact matching — three subsystems
 * this flow is not testing, each able to fail it for unrelated reasons.
 *
 * Single-message threads are deliberate: `handleThreadClick` in `inbox-shell.tsx`
 * auto-expands the body only for those, which is what puts a body fetch on the
 * click and makes the stale-response race reachable at all.
 */
export async function seedInboxMessage(
  userId: string,
  opts: { gmailMessageId: string; subject: string; from?: string; snippet?: string; date?: string },
): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.from("email_messages").insert({
    user_id: userId,
    gmail_message_id: opts.gmailMessageId,
    // Its own thread, so `buildThreads` yields one thread per seeded message.
    thread_id: opts.gmailMessageId,
    subject: opts.subject,
    from_address: opts.from ?? "sender@example.com",
    to_addresses: ["e2e-sender@gmail.com"],
    snippet: opts.snippet ?? opts.subject,
    // Inbound AND unread together are what the unread badge keys on
    // (`unreadDeltaFor`), so the mark-as-read assertion has something to observe.
    direction: "inbound",
    is_read: false,
    is_trashed: false,
    is_hidden: false,
    date: opts.date ?? new Date().toISOString(),
    label_ids: ["INBOX"],
  });
  if (error) throw new Error(`seedInboxMessage(${opts.gmailMessageId}): ${error.message}`);
}

/** A contact with one primary, non-bounced address — the send path's happy case. */
export async function seedContact(
  userId: string,
  opts: { name?: string; email?: string } = {},
): Promise<{ contactId: number; name: string; email: string }> {
  const svc = serviceClient();
  const name = opts.name ?? uniq("E2E Contact");
  const email = opts.email ?? `${uniq("e2e-contact")}@example.com`;

  const { data: contact, error } = await svc
    .from("contacts")
    .insert({ user_id: userId, name })
    .select("id")
    .single();
  if (error || !contact) throw new Error(`seedContact: ${error?.message ?? "no row"}`);

  const { error: emailErr } = await svc
    .from("contact_emails")
    .insert({ contact_id: contact.id, email, is_primary: true });
  if (emailErr) throw new Error(`seedContact email: ${emailErr.message}`);

  return { contactId: contact.id, name, email };
}

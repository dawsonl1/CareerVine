#!/usr/bin/env node
/**
 * Verifies the plan-32 security boundaries against a REAL database — the
 * checks the mocked unit suite cannot make (RLS, column privileges, the
 * bundle_visible_to predicate).
 *
 * Creates a disposable test user, signs in as them, and asserts:
 *   1. self profile update works (first_name)
 *   2. self status escalation is BLOCKED
 *   3. a bundle hidden by a deny override disappears from their SELECT
 *   4. self-subscribing to that hidden bundle is BLOCKED
 *   5. bundle_access_overrides, admin_audit_log, and user_ai_access are
 *      unreadable/unwritable by users
 * Then deletes the test user (cascade) and its override rows.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   node scripts/verify-admin-rls.mjs
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const email = `rls-verify-${Date.now()}@example.com`;
const password = `Vrfy!${Math.random().toString(36).slice(2)}${Date.now()}`;

let userId = null;
try {
  // ── Setup: disposable user + user-scoped client ───────────────────────
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: "RLS", last_name: "Verify" },
  });
  if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
  userId = created.user.id;

  const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signInErr } = await userClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);

  // ── 1. Profile self-update allowed ────────────────────────────────────
  {
    const { error } = await userClient
      .from("users").update({ first_name: "Updated" }).eq("id", userId);
    check("user can update own profile fields", !error, error?.message);
  }

  // ── 2. Privileged-column self-escalation blocked ──────────────────────
  {
    const { error } = await userClient
      .from("users").update({ status: "suspended" }).eq("id", userId);
    check("user CANNOT update own status", !!error, error ? error.code : "update succeeded!");
  }
  {
    // Verify the escalation truly didn't land.
    const { data } = await service
      .from("users").select("status").eq("id", userId).single();
    check("status unchanged in DB", data?.status === "active", JSON.stringify(data));
  }
  {
    // Shared-key entitlement (user_ai_access) must not be self-grantable.
    const { error } = await userClient
      .from("user_ai_access")
      .upsert({ user_id: userId, shared_access: true });
    check("user CANNOT self-grant shared AI access", !!error, error ? error.code : "upsert succeeded!");
  }

  // ── 4/5. Bundle visibility via a deny override ────────────────────────
  const { data: someBundle } = await service
    .from("data_bundles").select("id, name").eq("status", "published").limit(1).maybeSingle();

  if (!someBundle) {
    console.log("  – no published bundle in DB; skipping visibility checks (4/5)");
  } else {
    const bundleId = someBundle.id;
    const { error: ovErr } = await service.from("bundle_access_overrides").upsert({
      user_id: userId, bundle_id: bundleId, allowed: false,
    });
    if (ovErr) throw new Error(`override upsert failed: ${ovErr.message}`);

    {
      const { data } = await userClient.from("data_bundles").select("id");
      const visibleIds = (data ?? []).map((b) => b.id);
      check(
        "deny-overridden bundle is invisible to the user",
        !visibleIds.includes(bundleId),
        `visible ids: [${visibleIds.join(", ")}]`,
      );
    }
    {
      const { error } = await userClient
        .from("bundle_subscriptions").insert({ user_id: userId, bundle_id: bundleId });
      check("user CANNOT self-subscribe to a hidden bundle", !!error, error ? error.code : "insert succeeded!");
    }
    {
      // Grant path: flip the override to allowed and confirm it appears.
      await service.from("bundle_access_overrides").upsert({
        user_id: userId, bundle_id: bundleId, allowed: true,
      });
      const { data } = await userClient.from("data_bundles").select("id");
      check(
        "grant-overridden bundle becomes visible",
        ((data ?? []).map((b) => b.id)).includes(bundleId),
      );
    }
  }

  // ── 6. Admin-only tables are unreadable ───────────────────────────────
  {
    const { data, error } = await userClient.from("bundle_access_overrides").select("user_id");
    check("bundle_access_overrides unreadable by users", !!error || (data ?? []).length === 0, error?.code);
  }
  {
    const { data, error } = await userClient.from("admin_audit_log").select("id");
    check("admin_audit_log unreadable by users", !!error || (data ?? []).length === 0, error?.code);
  }
  {
    const { data, error } = await userClient.from("user_ai_access").select("user_id");
    check("user_ai_access unreadable by users", !!error || (data ?? []).length === 0, error?.code);
  }
} catch (err) {
  console.error(`Setup/verify error: ${err.message}`);
  process.exitCode = 1;
} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────
  if (userId) {
    await service.from("bundle_access_overrides").delete().eq("user_id", userId);
    const { error } = await service.auth.admin.deleteUser(userId);
    console.log(error ? `Cleanup FAILED: ${error.message} (user ${userId})` : `Cleaned up test user ${email}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0
  ? `\nAll ${results.length} RLS checks passed.`
  : `\n${failed.length}/${results.length} RLS checks FAILED.`);
process.exit(failed.length === 0 && process.exitCode !== 1 ? 0 : 1);

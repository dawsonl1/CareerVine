#!/usr/bin/env node
/**
 * Grant (or revoke) CareerVine admin on a user account by setting
 * auth.users.app_metadata.role = 'admin'. app_metadata is service-role-only,
 * so this is the trusted way to mint the FIRST admin. Every subsequent
 * grant/revoke should go through the in-app Make-admin control instead.
 *
 * The change only enters the user's JWT on their next token refresh, so the
 * granted user must sign out and back in once before /admin is reachable.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/grant-admin.mjs --email you@example.com [--revoke]
 *
 * Env is read from the shell; source .env.local first if that's where the prod
 * service-role key lives (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 */

import { createClient } from "@supabase/supabase-js";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = process.argv[i + 1];
    return next && !next.startsWith("--") ? next : true;
  }
  return fallback;
}

const email = arg("email");
const revoke = arg("revoke") === true;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || typeof email !== "string") {
  console.error("Missing --email <address>");
  process.exit(1);
}
if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});

async function findUserByEmail(target) {
  const needle = target.toLowerCase();
  const perPage = 200;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => (u.email ?? "").toLowerCase() === needle);
    if (match) return match;
    if (data.users.length < perPage) return null;
  }
}

const user = await findUserByEmail(email);
if (!user) {
  console.error(`No auth user found with email ${email}`);
  process.exit(1);
}

const nextRole = revoke ? null : "admin";
const nextAppMetadata = { ...(user.app_metadata ?? {}), role: nextRole ?? undefined };
if (revoke) delete nextAppMetadata.role;

const { error } = await supabase.auth.admin.updateUserById(user.id, {
  app_metadata: nextAppMetadata,
});
if (error) {
  console.error(`updateUserById failed: ${error.message}`);
  process.exit(1);
}

console.log(
  revoke
    ? `Revoked admin from ${email} (${user.id}).`
    : `Granted admin to ${email} (${user.id}). They must sign out and back in once for it to take effect.`,
);

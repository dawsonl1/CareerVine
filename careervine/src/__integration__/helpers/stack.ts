/**
 * Integration-tier harness (CAR-178): clients and tenants against the LOCAL
 * Supabase stack. Endpoints/keys come from process.env, published by
 * ../global-setup.ts (which refuses non-loopback stacks).
 *
 * Three ways to talk to the database, by trust level:
 *  - serviceClient(): service-role key through PostgREST — bypasses RLS,
 *    exactly like app cron/MCP code paths.
 *  - Tenant.client: anon key + a real signed-in session — RLS enforced,
 *    exactly like the browser. This is the client isolation tests use.
 *  - pgPool(): raw Postgres (test-code only, never app code) for what
 *    PostgREST cannot express: catalog introspection and cross-table censuses.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/database.types";

export type Db = SupabaseClient<Database>;

/**
 * Dynamic-table access for generic probes (iterating seeded rows across all
 * tables). Deliberately drops the Database generic: with a union table name,
 * supabase-js's typed builder explodes into TS2589; the probes only need the
 * untyped builder surface.
 */
export function fromTable(client: Db, table: string) {
  return (client as SupabaseClient).from(table);
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is unset — global-setup did not run (use vitest.integration.config.ts)`);
  }
  return v;
}

export function stackEnv() {
  return {
    url: envOrThrow("ITEST_SUPABASE_URL"),
    anonKey: envOrThrow("ITEST_ANON_KEY"),
    serviceKey: envOrThrow("ITEST_SERVICE_ROLE_KEY"),
    dbUrl: envOrThrow("ITEST_DB_URL"),
  };
}

export function serviceClient(): Db {
  const { url, serviceKey } = stackEnv();
  return createClient<Database>(url, serviceKey, { auth: { persistSession: false } });
}

/** One pool per test file; close it in afterAll via pool.end(). */
export function pgPool(): Pool {
  return new Pool({ connectionString: stackEnv().dbUrl, max: 4 });
}

export interface Tenant {
  userId: string;
  email: string;
  /** Anon-key client holding this user's real session — RLS applies. */
  client: Db;
}

/**
 * Create a confirmed auth user and sign in as them. The
 * on_auth_user_created trigger gives the tenant its public.users row
 * (status 'active', so cron paths treat it as live).
 */
export async function createTenant(label: string): Promise<Tenant> {
  const { url, anonKey } = stackEnv();
  const svc = serviceClient();
  const email = `itest-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `itest-${randomUUID()}`;

  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: "Itest", last_name: label },
  });
  if (createErr || !created.user) {
    throw new Error(`createTenant(${label}): ${createErr?.message ?? "no user returned"}`);
  }

  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`createTenant(${label}) sign-in: ${signInErr.message}`);

  return { userId: created.user.id, email, client };
}

/** Delete the auth user; public rows follow via the users FK cascade. */
export async function deleteTenant(userId: string): Promise<void> {
  const svc = serviceClient();
  const { error } = await svc.auth.admin.deleteUser(userId);
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`deleteTenant(${userId}): ${error.message}`);
  }
}

/** Short unique suffix for values that must not collide across runs. */
export function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

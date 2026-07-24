/**
 * PostgREST role-grant lockdowns (CAR-181).
 *
 * CAR-178's blanket `GRANT ALL ON ALL TABLES/FUNCTIONS TO anon, authenticated`
 * (20260724091000) silently reversed ~14 deliberate REVOKE-based lockdowns from
 * earlier migrations — most seriously, it made two SECURITY DEFINER write
 * functions (apply_bundle_resolutions, replace_transcript_segments) callable by
 * anon, i.e. unauthenticated cross-tenant write primitives that bypass RLS.
 * CAR-181 (20260724100000) re-asserts the intended grant set.
 *
 * These assertions run against the real migrated database and go RED if any
 * lockdown is reverted again (e.g. a future blanket GRANT ALL, or an
 * ALTER DEFAULT PRIVILEGES that re-adds anon). Grants are orthogonal to RLS:
 * this suite checks the grant layer; rls-tenant-isolation.itest.ts checks rows.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import { pgPool } from "./helpers/stack";

let pool: Pool;
beforeAll(() => {
  pool = pgPool();
});
afterAll(async () => {
  await pool.end();
});

// Every function a pre-CAR-178 migration deliberately revoked, with the exact
// signature and the intended executor set. `anon` must be false for ALL of them.
const FUNCTIONS: { sig: string; anon: false; authenticated: boolean }[] = [
  // service_role only (browser roles fully revoked)
  { sig: "apply_bundle_resolutions(jsonb)", anon: false, authenticated: false },
  { sig: "increment_ai_shared_usage(uuid, date, numeric)", anon: false, authenticated: false },
  { sig: "user_is_internal(uuid)", anon: false, authenticated: false },
  { sig: "is_internal_email(text)", anon: false, authenticated: false },
  // authenticated (+ service) — anon revoked
  { sig: "replace_transcript_segments(integer, jsonb)", anon: false, authenticated: true },
  { sig: "bundle_alumni_stats(integer)", anon: false, authenticated: true },
  { sig: "user_company_alumni_counts()", anon: false, authenticated: true },
  { sig: "bundle_company_stats(integer)", anon: false, authenticated: true },
  { sig: "network_tier_counts()", anon: false, authenticated: true },
  { sig: "save_pipeline_cycle(integer, integer, jsonb)", anon: false, authenticated: true },
  { sig: "delete_pipeline_cycle(integer, integer)", anon: false, authenticated: true },
];

it("no locked function is executable by anon; service-only functions are not executable by authenticated", async () => {
  const wrong: string[] = [];
  for (const f of FUNCTIONS) {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS auth`,
      [`public.${f.sig}`],
    );
    const { anon, auth } = rows[0];
    if (anon !== f.anon) wrong.push(`${f.sig}: anon EXECUTE = ${anon} (want ${f.anon})`);
    if (auth !== f.authenticated) wrong.push(`${f.sig}: authenticated EXECUTE = ${auth} (want ${f.authenticated})`);
  }
  expect(wrong, wrong.join("\n")).toEqual([]);
});

// Pre-existing SECURITY DEFINER functions anon may execute, each reviewed benign
// (CAR-181). These predate CAR-178 (never revoked; anon holds EXECUTE via
// Postgres's default PUBLIC grant, not the blanket grant) and are safe:
//   - handle_new_user: an auth.users INSERT trigger. Returns `trigger`, so
//     PostgREST cannot expose it as RPC; the grant is inert.
//   - bundle_visible_to: a boolean visibility helper used inside the bundle RLS
//     policies (all TO authenticated). Returns only a boolean, leaks no rows.
// A NEW anon-executable SECURITY DEFINER function must be reviewed and added
// here deliberately, or the lockdown that keeps it service/authenticated-only
// must be added — this test forces that decision.
const ANON_SECDEF_ALLOWLIST = new Set([
  "handle_new_user()",
  "bundle_visible_to(p_bundle_id integer, p_user uuid)",
]);

it("NO un-allowlisted SECURITY DEFINER function in public is executable by anon (catches any future re-exposure)", async () => {
  const { rows } = await pool.query<{ sig: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
      ORDER BY 1`,
  );
  const exposed = rows.map((r) => r.sig).filter((s) => !ANON_SECDEF_ALLOWLIST.has(s));
  expect(exposed, `SECURITY DEFINER functions anon can execute (not allowlisted):\n${exposed.join("\n")}`).toEqual([]);
});

it("gmail_connections OAuth token columns are unreadable by the browser role; metadata stays readable", async () => {
  const { rows } = await pool.query<Record<string, boolean>>(
    `SELECT
       has_column_privilege('authenticated','gmail_connections','access_token','SELECT')     AS token,
       has_column_privilege('authenticated','gmail_connections','refresh_token','SELECT')     AS refresh,
       has_column_privilege('authenticated','gmail_connections','token_expires_at','SELECT')  AS expires,
       has_column_privilege('authenticated','gmail_connections','gmail_address','SELECT')     AS meta,
       has_column_privilege('authenticated','gmail_connections','send_scope_granted','SELECT') AS scope,
       has_table_privilege('anon','gmail_connections','SELECT')                               AS anon_any`,
  );
  const r = rows[0];
  expect(r.token, "authenticated must NOT read access_token").toBe(false);
  expect(r.refresh, "authenticated must NOT read refresh_token").toBe(false);
  expect(r.expires, "authenticated must NOT read token_expires_at").toBe(false);
  expect(r.meta, "authenticated MUST read gmail_address metadata").toBe(true);
  expect(r.scope, "authenticated MUST read send_scope_granted").toBe(true);
  expect(r.anon_any, "anon must have no access to gmail_connections").toBe(false);
});

it("service-only tables reject browser-role access; ai_shared_usage keeps read but not write", async () => {
  const checks: [string, string, string, boolean][] = [
    // grantee, table, priv, expected
    ["authenticated", "user_api_keys", "SELECT", false],
    ["authenticated", "user_api_keys", "INSERT", false],
    ["authenticated", "user_ai_access", "SELECT", false],
    ["authenticated", "user_ai_access", "UPDATE", false],
    ["authenticated", "bundle_access_overrides", "INSERT", false],
    ["authenticated", "admin_audit_log", "INSERT", false],
    ["authenticated", "admin_audit_log", "SELECT", false],
    ["authenticated", "ai_shared_usage", "INSERT", false],
    ["authenticated", "ai_shared_usage", "UPDATE", false],
    ["authenticated", "ai_shared_usage", "SELECT", true], // own-row RLS policy needs the grant
  ];
  const wrong: string[] = [];
  for (const [grantee, table, priv, want] of checks) {
    const { rows } = await pool.query<{ v: boolean }>(
      `SELECT has_table_privilege($1, $2, $3) AS v`,
      [grantee, table, priv],
    );
    if (rows[0].v !== want) wrong.push(`${grantee} ${priv} ${table} = ${rows[0].v} (want ${want})`);
  }
  expect(wrong, wrong.join("\n")).toEqual([]);
});

it("users: authenticated may UPDATE only its profile columns, never status/feature flags; anon has nothing", async () => {
  const profile = ["first_name", "last_name", "email", "phone", "onboarding_state", "followup_nudges_enabled"];
  const locked = ["status", "apify_enrichment_enabled", "diff_analysis_enabled", "discovery_enabled"];
  const wrong: string[] = [];
  for (const col of profile) {
    const { rows } = await pool.query<{ v: boolean }>(
      `SELECT has_column_privilege('authenticated','users',$1,'UPDATE') AS v`, [col]);
    if (!rows[0].v) wrong.push(`authenticated should UPDATE users.${col} but cannot`);
  }
  for (const col of locked) {
    const { rows } = await pool.query<{ v: boolean }>(
      `SELECT has_column_privilege('authenticated','users',$1,'UPDATE') AS v`, [col]);
    if (rows[0].v) wrong.push(`authenticated must NOT UPDATE users.${col} but can`);
  }
  const { rows: anonRows } = await pool.query<{ v: boolean }>(
    `SELECT has_table_privilege('anon','users','UPDATE') AS v`);
  if (anonRows[0].v) wrong.push("anon must have no UPDATE on users");
  expect(wrong, wrong.join("\n")).toEqual([]);
});

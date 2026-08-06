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
import { SEND_WATCHER } from "@/lib/watcher-health";

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
  // Watcher-login only (CAR-220). Reads platform-wide pending-send counts under
  // SECURITY DEFINER, so no browser role has any business calling it.
  { sig: "due_send_counts()", anon: false, authenticated: false },
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
  const exposed = await unallowlistedSecdef("anon", ANON_SECDEF_ALLOWLIST);
  expect(exposed, `SECURITY DEFINER functions anon can execute (not allowlisted):\n${exposed.join("\n")}`).toEqual([]);
});

/**
 * The same sweep for `authenticated` (CAR-220).
 *
 * The anon leg above shipped alone, and it checks the role that a new function
 * does NOT automatically receive. Verified against this stack's `pg_default_acl`
 * (asserted below so it cannot rot): the default-privilege row that applies to
 * migrations — grantor `postgres`, schema `public`, objtype `f` — grants EXECUTE
 * to postgres, authenticated and service_role, and does not name anon. So every
 * function a migration creates is authenticated-executable from birth, while
 * anon's EXECUTE only ever comes from the built-in PUBLIC grant or from a
 * blanket GRANT like CAR-178's.
 *
 * The consequence was live: CAR-215's `due_send_counts()` wrote
 * `REVOKE ALL ... FROM PUBLIC`, which strips the PUBLIC grant anon rides on but
 * not the explicit `authenticated` one — so the anon sweep stayed green while
 * any logged-in user could POST /rest/v1/rpc/due_send_counts and read
 * platform-wide pending-send counts. A guard that only watches anon cannot see
 * the role that the defaults actually hand things to.
 *
 * Entries here are functions reviewed as safe for a logged-in user to call:
 *   - handle_new_user: an auth.users INSERT trigger. Returns `trigger`, so
 *     PostgREST cannot expose it as RPC; the grant is inert.
 *   - bundle_visible_to: boolean visibility helper used inside bundle RLS
 *     policies. Returns a boolean, leaks no rows.
 *   - bundle_alumni_stats: deliberately authenticated-callable, and pinned as
 *     such in FUNCTIONS above. Scopes its own work to the caller's bundle
 *     rather than trusting RLS.
 *
 * `replace_transcript_segments` was listed here until CAR-237 on the stated
 * grounds that it "scopes its own work to the caller's meeting". It did not —
 * it was SECURITY DEFINER with no ownership check at all, so any authenticated
 * user could replace another user's transcript segments (proven against
 * production before the fix). CAR-237 made it SECURITY INVOKER so RLS enforces,
 * which is why it no longer belongs in a SECURITY DEFINER allowlist. Its grants
 * are unchanged and stay pinned in FUNCTIONS above.
 */
const AUTHENTICATED_SECDEF_ALLOWLIST = new Set([
  "handle_new_user()",
  "bundle_visible_to(p_bundle_id integer, p_user uuid)",
  "bundle_alumni_stats(p_bundle_id integer)",
]);

async function unallowlistedSecdef(role: string, allowlist: Set<string>): Promise<string[]> {
  const { rows } = await pool.query<{ sig: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND has_function_privilege($1, p.oid, 'EXECUTE')
      ORDER BY 1`,
    [role],
  );
  return rows.map((r) => r.sig).filter((s) => !allowlist.has(s));
}

it("NO un-allowlisted SECURITY DEFINER function in public is executable by authenticated (CAR-220)", async () => {
  const exposed = await unallowlistedSecdef("authenticated", AUTHENTICATED_SECDEF_ALLOWLIST);
  expect(
    exposed,
    "SECURITY DEFINER functions any logged-in user can execute (not allowlisted):\n" +
      `${exposed.join("\n")}\n` +
      "Either review it and add it to AUTHENTICATED_SECDEF_ALLOWLIST, or REVOKE EXECUTE " +
      "FROM authenticated in a migration. Note that REVOKE ... FROM PUBLIC does NOT do this: " +
      "the grant comes from Supabase's ALTER DEFAULT PRIVILEGES and must be named explicitly.",
  ).toEqual([]);
});

it("the sweeps above are not vacuous: both allowlists still name live functions", async () => {
  // `toEqual([])` over a query that matched nothing passes and reports success.
  // Anchor both legs to the fact that the allowlisted functions really are
  // SECURITY DEFINER and really are executable by that role today.
  for (const [role, allowlist] of [
    ["anon", ANON_SECDEF_ALLOWLIST],
    ["authenticated", AUTHENTICATED_SECDEF_ALLOWLIST],
  ] as const) {
    const { rows } = await pool.query<{ sig: string }>(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [role],
    );
    const live = new Set(rows.map((r) => r.sig));
    const missing = [...allowlist].filter((s) => !live.has(s));
    expect(
      missing,
      `${role} allowlist entries that no longer match a ${role}-executable SECURITY DEFINER ` +
        `function — the sweep is now weaker than it reads: ${missing.join(", ")}`,
    ).toEqual([]);
  }
});

it("Supabase still grants function EXECUTE to authenticated by default (the reason the leg above exists)", async () => {
  // The rationale for the authenticated sweep is a property of the stack, not of
  // our SQL. If Supabase ever stops attaching this grant, this goes red and the
  // comment above gets re-read rather than quietly becoming folklore.
  const { rows } = await pool.query<{ acl: string[] }>(
    `SELECT defaclacl::text[] AS acl
       FROM pg_default_acl
      WHERE defaclnamespace = 'public'::regnamespace
        AND defaclobjtype = 'f'
        AND pg_get_userbyid(defaclrole) = 'postgres'`,
  );
  expect(rows.length, "no postgres-owned default ACL for public functions").toBe(1);
  const acl = rows[0].acl.join(",");
  expect(acl, "authenticated should hold a default EXECUTE grant on new functions").toContain(
    "authenticated=X",
  );
  expect(acl, "anon is NOT in this default ACL — that is why the anon sweep alone missed CAR-215").not.toContain(
    "anon=X",
  );
});

it("due_send_counts is executable by the watcher login and nothing else (CAR-220)", async () => {
  // The functional half of the lockdown: revoking too widely would silently stop
  // the A1 watcher, which is the one caller that must keep working.
  const want: Record<string, boolean> = {
    careervine_watcher: true,
    anon: false,
    authenticated: false,
    service_role: false,
  };
  const wrong: string[] = [];
  for (const [role, expected] of Object.entries(want)) {
    const { rows } = await pool.query<{ v: boolean }>(
      `SELECT has_function_privilege($1, 'public.due_send_counts()', 'EXECUTE') AS v`,
      [role],
    );
    if (rows[0].v !== expected) wrong.push(`${role} EXECUTE = ${rows[0].v} (want ${expected})`);
  }
  expect(wrong, wrong.join("\n")).toEqual([]);
});

it("careervine_watcher holds no table privileges in public (CAR-220)", async () => {
  // 20260803130000 claimed an `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES
  // FROM careervine_watcher` protected this. It does not: default privileges only
  // cancel a matching prior default GRANT (that statement recorded nothing in
  // pg_default_acl), and they govern future objects while `GRANT ON ALL TABLES`
  // acts on existing ones. Running that GRANT in a transaction did hand the role
  // SELECT on scheduled_emails with the old line in place.
  //
  // So the property is asserted here instead, where it can actually hold: the
  // login that sits on a VM must be able to call one function and read nothing.
  const { rows } = await pool.query<{ rel: string; privs: string }>(
    `SELECT c.relname AS rel, string_agg(DISTINCT a.privilege_type, ',') AS privs
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
        AND pg_get_userbyid(a.grantee) = 'careervine_watcher'
      GROUP BY 1 ORDER BY 1`,
  );
  expect(
    rows.map((r) => `${r.rel}: ${r.privs}`),
    "careervine_watcher must hold no table/sequence privileges — it reports liveness by " +
      "calling the app, and reads state through due_send_counts() alone",
  ).toEqual([]);
});

it("cron_heartbeats carries the send-watcher row, so a never-seen watcher is not read as healthy (CAR-220)", async () => {
  // checkWatcherHealth() returns "idle" when the row is absent, so before the
  // seed a watcher that had never once authenticated produced no row and the
  // dead-watcher alarm could never arm. The row's existence is what arms it.
  //
  // Keyed off the app's own constant, so renaming SEND_WATCHER without
  // re-seeding under the new name goes red here rather than in production.
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM cron_heartbeats WHERE name = $1`,
    [SEND_WATCHER],
  );
  expect(rows[0].n, `migrations must seed the "${SEND_WATCHER}" heartbeat row`).toBe("1");
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

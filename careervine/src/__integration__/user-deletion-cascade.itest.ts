/**
 * Account-deletion cascade, executed instead of reasoned about (CAR-178).
 *
 * Seeds the full tenant graph, deletes the auth user (the same
 * auth.admin.deleteUser call the admin delete route makes), then asserts:
 *
 *  1. Every recorded user-owned row is GONE — including junction rows on
 *     tables added by later waves, which is exactly what a silently dropped
 *     ON DELETE CASCADE would strand.
 *  2. A census over every public table that carries a user_id column finds
 *     zero rows for the deleted id — catching user-owned rows the fixture
 *     recorder might miss.
 *  3. Shared-catalog rows (companies, schools, locations, bundles) SURVIVE:
 *     deleting one tenant must not eat shared product data.
 *  4. admin_audit_log rows survive by design — the audit trail deliberately
 *     carries no user FK so it outlives the account.
 *  5. A second, untouched tenant's graph is fully intact afterwards — the
 *     cascade must not overreach across tenants.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenant,
  deleteTenant,
  fromTable,
  pgPool,
  serviceClient,
  type Db,
  type Tenant,
} from "./helpers/stack";
import { seedTenantGraph, type SeededRow, type TenantGraph } from "./helpers/tenant-graph";

let svc: Db;
let pool: Pool;
let doomed: Tenant;
let bystander: Tenant;
let doomedGraph: TenantGraph;
let bystanderGraph: TenantGraph;

async function countMatch(row: SeededRow): Promise<number> {
  const { count, error } = await fromTable(svc, row.table)
    .select("*", { count: "exact", head: true })
    .match(row.match);
  if (error) throw new Error(`count ${row.table}: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  svc = serviceClient();
  pool = pgPool();
  doomed = await createTenant("cascade-doomed");
  bystander = await createTenant("cascade-bystander");
  doomedGraph = await seedTenantGraph(svc, doomed.userId);
  bystanderGraph = await seedTenantGraph(svc, bystander.userId);

  // Sanity: every recorded row exists before deletion, so "gone afterwards"
  // means the cascade removed it, not that it never existed.
  for (const row of [...doomedGraph.rows, ...doomedGraph.auditRows]) {
    if ((await countMatch(row)) < 1) {
      throw new Error(`pre-delete sanity: ${row.table} ${JSON.stringify(row.match)} missing`);
    }
  }

  await deleteTenant(doomed.userId);
});

afterAll(async () => {
  if (bystander) await deleteTenant(bystander.userId);
  for (const graph of [doomedGraph, bystanderGraph]) {
    if (!graph) continue;
    for (const row of [...graph.sharedRows].reverse()) {
      await fromTable(svc, row.table).delete().match(row.match);
    }
    for (const row of graph.auditRows) {
      await fromTable(svc, row.table).delete().match(row.match);
    }
  }
  await pool.end();
});

it("every seeded user-owned row is gone after auth user deletion", async () => {
  const survivors: string[] = [];
  for (const row of doomedGraph.rows) {
    if ((await countMatch(row)) > 0) {
      survivors.push(`${row.table} ${JSON.stringify(row.match)}`);
    }
  }
  expect(survivors, "rows a dropped ON DELETE CASCADE would strand").toEqual([]);
});

it("census: no table with a user_id column retains rows for the deleted user", async () => {
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
     JOIN pg_class pc ON pc.relname = c.table_name
     JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
     WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND pc.relkind = 'r'
     ORDER BY 1`,
  );
  expect(tables.length).toBeGreaterThan(10);

  const survivors: string[] = [];
  for (const { table_name } of tables) {
    const { rows } = await pool.query<{ n: string }>(
      // table_name comes from the catalog, not user input; quote_ident-style
      // interpolation is safe here and PostgREST can't parameterize FROM.
      `SELECT count(*) AS n FROM public."${table_name}" WHERE user_id = $1`,
      [doomed.userId],
    );
    if (Number(rows[0].n) > 0) survivors.push(`${table_name}: ${rows[0].n} rows`);
  }
  expect(survivors, "user_id rows surviving account deletion").toEqual([]);
});

it("shared catalog rows survive a tenant's deletion", async () => {
  const missing: string[] = [];
  for (const row of doomedGraph.sharedRows) {
    if ((await countMatch(row)) < 1) missing.push(`${row.table} ${JSON.stringify(row.match)}`);
  }
  expect(missing, "shared rows wrongly deleted with the tenant").toEqual([]);
});

it("admin audit rows survive by design (no user FK on admin_audit_log)", async () => {
  for (const row of doomedGraph.auditRows) {
    expect(await countMatch(row), `${row.table} must outlive the account`).toBeGreaterThan(0);
  }
});

it("an untouched tenant's graph is fully intact", async () => {
  const missing: string[] = [];
  for (const row of bystanderGraph.rows) {
    if ((await countMatch(row)) < 1) missing.push(`${row.table} ${JSON.stringify(row.match)}`);
  }
  expect(missing, "bystander rows lost to an overreaching cascade").toEqual([]);
});

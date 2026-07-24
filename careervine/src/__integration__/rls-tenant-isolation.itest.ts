/**
 * Tenant isolation against real RLS (CAR-178).
 *
 * Two real tenants (anon key + signed-in sessions), each with a full data
 * graph. For EVERY user-owned row of tenant B, tenant A must not be able to
 * read, update, or delete it; targeted probes then assert the WITH CHECK
 * side (cross-tenant inserts refused on both legs of every junction, and
 * direct user_id spoofing refused).
 *
 * A completeness guard introspects the live catalog: every public table must
 * have RLS enabled, and every RLS table must either carry a probed seeded
 * row or an entry in an explicit exemption map — so a new table cannot ship
 * without an isolation decision.
 *
 * This is the suite that must go red when a policy loses an ownership leg
 * (the CAR-159 class of defect).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenant,
  deleteTenant,
  fromTable,
  pgPool,
  serviceClient,
  uniq,
  type Db,
  type Tenant,
} from "./helpers/stack";
import {
  seedTenantGraph,
  type SeededRow,
  type TableName,
  type TenantGraph,
} from "./helpers/tenant-graph";

/**
 * Tables deliberately NOT probed row-by-row, each with the reason it is safe.
 * The completeness guard fails on any RLS table missing from both this map
 * and the seeded graph, and on any stale entry here.
 */
const EXEMPT_TABLES: Record<string, string> = {
  companies: "shared catalog: select_all + insert/update for authenticated is intentional",
  schools: "shared catalog: select_all + insert for authenticated is intentional",
  locations: "shared catalog: canonical location rows are global by design",
  company_locations: "child of the shared company catalog, no tenant data",
  data_bundles: "published bundles are a shared product surface (select_published)",
  bundle_companies: "bundle-owned; visibility gated by subscription (probed below)",
  bundle_prospects: "bundle-owned; visibility gated by subscription (probed below)",
  internal_analytics_emails: "service-only allowlist keyed by email, no tenant rows (deny-all probed below)",
};

let svc: Db;
let pool: Pool;
let a: Tenant;
let b: Tenant;
let graphA: TenantGraph;
let graphB: TenantGraph;

beforeAll(async () => {
  svc = serviceClient();
  pool = pgPool();
  a = await createTenant("iso-a");
  b = await createTenant("iso-b");
  graphA = await seedTenantGraph(svc, a.userId);
  graphB = await seedTenantGraph(svc, b.userId);
});

afterAll(async () => {
  if (a) await deleteTenant(a.userId);
  if (b) await deleteTenant(b.userId);
  // Shared-catalog rows have no user FK; remove them explicitly, children first.
  for (const graph of [graphA, graphB]) {
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

/** Rows of B's graph that tenant A gets probed against. */
function probedRows(): SeededRow[] {
  return [...graphB.rows, ...graphB.auditRows];
}

it("every public table has RLS enabled", async () => {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
     ORDER BY 1`,
  );
  expect(rows.map((r) => r.relname)).toEqual([]);
});

it("every RLS table is either probed or explicitly exempted (and no stale exemptions)", async () => {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     ORDER BY 1`,
  );
  const live = rows.map((r) => r.relname);
  const probed = new Set<string>(probedRows().map((r) => r.table));

  const uncovered = live.filter((t) => !probed.has(t) && !(t in EXEMPT_TABLES));
  expect(uncovered, "RLS tables with no isolation probe and no exemption").toEqual([]);

  const stale = Object.keys(EXEMPT_TABLES).filter((t) => !live.includes(t));
  expect(stale, "exemptions for tables that no longer exist").toEqual([]);
});

it("tenant A cannot READ any of tenant B's rows", async () => {
  const leaks: string[] = [];
  for (const row of probedRows()) {
    const { count } = await fromTable(svc, row.table)
      .select("*", { count: "exact", head: true })
      .match(row.match);
    if (!count || count < 1) throw new Error(`probe target missing: ${row.table} ${JSON.stringify(row.match)}`);

    const { data, error } = await fromTable(a.client, row.table).select("*").match(row.match);
    if (!error && data && data.length > 0) leaks.push(row.table);
  }
  expect(leaks, "tables where A read B's row").toEqual([]);
});

it("tenant A cannot UPDATE any of tenant B's rows", async () => {
  const leaks: string[] = [];
  for (const row of probedRows()) {
    // Touch payload: first match column set to its own value — type-correct
    // for every table, and a no-op even if it somehow landed.
    const [k, v] = Object.entries(row.match)[0];
    const { count, error } = await fromTable(a.client, row.table)
      .update({ [k]: v }, { count: "exact" })
      .match(row.match);
    if (!error && (count ?? 0) > 0) leaks.push(row.table);
  }
  expect(leaks, "tables where A updated B's row").toEqual([]);
});

it("tenant A cannot DELETE any of tenant B's rows", async () => {
  const leaks: string[] = [];
  for (const row of probedRows()) {
    const { count, error } = await fromTable(a.client, row.table)
      .delete({ count: "exact" })
      .match(row.match);
    if (!error && (count ?? 0) > 0) leaks.push(row.table);

    const { count: still } = await fromTable(svc, row.table)
      .select("*", { count: "exact", head: true })
      .match(row.match);
    if (!still || still < 1) leaks.push(`${row.table} (row gone after A's delete)`);
  }
  expect(leaks, "tables where A deleted B's row").toEqual([]);
});

it("tenant A cannot INSERT rows spoofing tenant B's user_id", async () => {
  const contacts = await a.client
    .from("contacts")
    .insert({ user_id: b.userId, name: uniq("spoof") });
  expect(contacts.error, "contacts insert with B's user_id must be refused").not.toBeNull();

  const scheduled = await a.client.from("scheduled_emails").insert({
    user_id: b.userId,
    recipient_email: "x@example.com",
    subject: "spoof",
    body_html: "<p>x</p>",
    scheduled_send_at: new Date().toISOString(),
  });
  expect(scheduled.error, "scheduled_emails insert with B's user_id must be refused").not.toBeNull();
});

/**
 * Both ownership legs of every junction. For each: linking A's parent to B's
 * child is refused, linking B's parent to A's child is refused, and the
 * legitimate (A, A) link is accepted — proving the policy blocks the
 * cross-tenant leg specifically, not all writes.
 */
interface JunctionSpec {
  table: TableName;
  make: (left: TenantGraph, right: TenantGraph) => Record<string, string | number | boolean>;
}

const JUNCTIONS: JunctionSpec[] = [
  {
    table: "email_message_contacts",
    make: (l, r) => ({ email_message_id: l.ids.emailMessageId, contact_id: r.ids.contactId }),
  },
  {
    table: "calendar_event_contacts",
    make: (l, r) => ({ calendar_event_id: l.ids.calendarEventId, contact_id: r.ids.contactId }),
  },
  {
    table: "meeting_contacts",
    make: (l, r) => ({ meeting_id: l.ids.meetingId, contact_id: r.ids.contactId }),
  },
  {
    table: "action_item_contacts",
    make: (l, r) => ({ action_item_id: l.ids.actionItemId, contact_id: r.ids.contactId }),
  },
  {
    table: "contact_tags",
    make: (l, r) => ({ contact_id: l.ids.contactId, tag_id: r.ids.tagId }),
  },
  {
    table: "contact_attachments",
    make: (l, r) => ({ contact_id: l.ids.contactId, attachment_id: r.ids.attachmentId }),
  },
  {
    table: "meeting_attachments",
    make: (l, r) => ({ meeting_id: l.ids.meetingId, attachment_id: r.ids.attachmentId }),
  },
  {
    table: "interaction_attachments",
    make: (l, r) => ({ interaction_id: l.ids.interactionId, attachment_id: r.ids.attachmentId }),
  },
  {
    table: "bundle_subscription_contacts",
    make: (l, r) => ({
      subscription_id: l.ids.subscriptionId,
      contact_id: r.ids.contactId,
      linkedin_url: `https://linkedin.com/in/${uniq("probe")}`,
      created_by_bundle: false,
      first_applied_version: 1,
      last_applied_version: 1,
    }),
  },
];

it("junction inserts are refused unless BOTH legs belong to the caller", async () => {
  const failures: string[] = [];
  for (const j of JUNCTIONS) {
    const crossChild = await fromTable(a.client, j.table).insert(j.make(graphA, graphB));
    if (!crossChild.error) failures.push(`${j.table}: A linked own parent to B's child`);

    const crossParent = await fromTable(a.client, j.table).insert(j.make(graphB, graphA));
    if (!crossParent.error) failures.push(`${j.table}: A linked B's parent to own child`);

    // action_item_contacts has a surrogate id and no unique(pair); the (A,A)
    // sanity row is fine to leave — the graph teardown cascades it. For pair-PK
    // tables the (A,A) pair may already exist from the seeded graph, so accept
    // duplicate-key (23505) as proof the policy let the write through.
    const own = await fromTable(a.client, j.table).insert(j.make(graphA, graphA));
    if (own.error && own.error.code !== "23505") {
      failures.push(`${j.table}: legitimate same-tenant link refused (${own.error.code}: ${own.error.message})`);
    }
  }
  expect(failures).toEqual([]);
});

it("bundle content is visible only through an active subscription", async () => {
  // Each tenant is subscribed to their own bundle only.
  const foreign = await a.client
    .from("bundle_prospects")
    .select("id")
    .eq("bundle_id", graphB.ids.bundleId);
  expect(foreign.error).toBeNull();
  expect(foreign.data, "A sees prospects of a bundle they are not subscribed to").toEqual([]);

  const own = await a.client
    .from("bundle_prospects")
    .select("id")
    .eq("bundle_id", graphA.ids.bundleId);
  expect(own.error).toBeNull();
  expect(own.data?.length, "A sees prospects of their subscribed bundle").toBeGreaterThan(0);

  const foreignCompanies = await a.client
    .from("bundle_companies")
    .select("id")
    .eq("bundle_id", graphB.ids.bundleId);
  expect(foreignCompanies.error).toBeNull();
  expect(foreignCompanies.data).toEqual([]);
});

it("internal_analytics_emails is deny-all for authenticated users", async () => {
  const email = `${uniq("internal")}@example.com`;
  const seeded = await svc.from("internal_analytics_emails").insert({ email });
  expect(seeded.error).toBeNull();
  try {
    const read = await a.client.from("internal_analytics_emails").select("*").eq("email", email);
    expect(!read.error ? read.data : [], "authenticated user read internal allowlist").toEqual([]);

    const write = await a.client
      .from("internal_analytics_emails")
      .insert({ email: `${uniq("w")}@example.com` });
    expect(write.error, "authenticated insert into internal allowlist must be refused").not.toBeNull();
  } finally {
    await svc.from("internal_analytics_emails").delete().eq("email", email);
  }
});

/**
 * TS ↔ SQL parity for the per-company network counts (CAR-229).
 *
 * CAR-229 moved two rules that TS already stated into Postgres: the per-company
 * count aggregation that `fetchUserEmploymentRows` + the JS agg loop used to do
 * in the browser, and the scope selection that `selectCompanyIds()` states. Both
 * now exist twice — once in `company_network_counts()` and once in
 * `src/lib/company-queries.ts` — with nothing but this file to notice when one
 * of them moves.
 *
 * Why ONE shared fixture rather than two suites: testing the SQL against its own
 * expectations and the TS against its own expectations proves each is
 * self-consistent and says nothing whatsoever about the failure that actually
 * happens, which is the two drifting apart. Every assertion below is driven off
 * the single ROLES/PEOPLE table, seeded once, then read by both halves.
 *
 * Parity alone is still satisfied by two implementations wrong in the SAME way,
 * so `EXPECTED_COUNTS` pins both engines to the fixture's declared intent — that
 * is the test that proves the fixture actually exercises the three subtleties
 * the SQL header calls out, rather than merely agreeing about them.
 *
 * Integration tier because the SQL half is only reachable through a real
 * Postgres with a real `auth.uid()`: the RPC is `security invoker` and filters
 * on the signed-in user, so it must be called through the tenant's own session
 * client. Under the service-role key `auth.uid()` is NULL and it returns
 * nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTenant,
  deleteTenant,
  serviceClient,
  uniq,
  type Db,
  type Tenant,
} from "./helpers/stack";
import { selectCompanyIds, type CompanyScope } from "@/lib/company-queries";

// ── The shared fixture ────────────────────────────────────────────────
//
// Network status is a property of the CONTACT, not of an employment row, so it
// lives on PEOPLE. ROLES then references people by key, which makes an
// inconsistent fixture (the same person "bench" at one company and "active" at
// another) unrepresentable.

type NetworkStatus = "active" | "prospect" | "bench";

const PEOPLE: Record<string, NetworkStatus> = {
  // Subtlety 2: left and came back. Two roles at one company, one former and
  // one current — must collapse to ONE person, counted current, not former.
  boomeranger: "active",
  // Subtlety 1, both halves: a bench contact is counted ONLY in bench_count.
  // One holds a CURRENT role and one a FORMER role, so a re-implementation that
  // forgot bench containment would leak into current_count or former_count.
  "bench-current": "bench",
  "bench-former": "bench",
  // Subtlety 3: former_count counts PEOPLE with no current role.
  "former-once": "active",
  // A prospect who is current feeds current_prospect_count...
  "prospect-current": "prospect",
  // ...and a prospect who is FORMER must not.
  "prospect-former": "prospect",
  // Two FORMER roles at the same company still collapse to one person.
  "twice-former": "active",
  // Sole contact at a bench-only company: that company has an aggregate row
  // with zero current and zero former, which only `minContacts = 0` selects.
  "bench-only": "bench",
  // Current but `active`, never a prospect: in_play sees it, pursuing must not.
  "active-current": "active",
  // Three formers at one company, so `minContacts` has a real threshold to
  // cross in the 'all' scope.
  "former-a": "active",
  "former-b": "active",
  "former-c": "active",
  // Employed at a company the user also targets.
  "target-employee": "active",
};

/** Every company the fixture creates, including one that gets no roles at all. */
const COMPANIES = [
  "acme",
  "twice-former-co",
  "bench-only-co",
  "prospect-only-co",
  "active-only-co",
  "former-only-co",
  "target-with-contacts-co",
  // A target with ZERO contacts. Always shown on /companies regardless of
  // contact count, so the RPC is handed it via p_extra_company_ids.
  "target-empty-co",
] as const;

/**
 * The user's target companies, passed as `p_extra_company_ids` and as
 * `selectCompanyIds`' target list. The real caller derives these from
 * `target_companies`; the RPC contract takes plain ids, so the test does too.
 */
const TARGET_COMPANIES = ["target-with-contacts-co", "target-empty-co"];

interface RoleRow {
  company: string;
  person: string;
  isCurrent: boolean;
  /** Distinct per (person, company): contact_companies_unique_idx is keyed
   *  (contact_id, company_id, start_date), so two roles need two dates. */
  startDate: string;
}

const ROLES: RoleRow[] = [
  // acme carries every subtlety at once.
  { company: "acme", person: "boomeranger", isCurrent: false, startDate: "2016-01-01" },
  { company: "acme", person: "boomeranger", isCurrent: true, startDate: "2021-01-01" },
  { company: "acme", person: "bench-current", isCurrent: true, startDate: "2020-01-01" },
  { company: "acme", person: "bench-former", isCurrent: false, startDate: "2019-01-01" },
  { company: "acme", person: "former-once", isCurrent: false, startDate: "2018-01-01" },
  { company: "acme", person: "prospect-current", isCurrent: true, startDate: "2022-01-01" },
  { company: "acme", person: "prospect-former", isCurrent: false, startDate: "2017-01-01" },

  // Same contact, two FORMER roles at one company → one person, not two.
  { company: "twice-former-co", person: "twice-former", isCurrent: false, startDate: "2015-01-01" },
  { company: "twice-former-co", person: "twice-former", isCurrent: false, startDate: "2019-06-01" },

  { company: "bench-only-co", person: "bench-only", isCurrent: true, startDate: "2021-01-01" },

  // The same prospect works at two companies: counts are per-company, so this
  // catches an aggregation that leaked a person across company boundaries.
  { company: "prospect-only-co", person: "prospect-current", isCurrent: true, startDate: "2023-01-01" },

  { company: "active-only-co", person: "active-current", isCurrent: true, startDate: "2021-01-01" },

  { company: "former-only-co", person: "former-a", isCurrent: false, startDate: "2014-01-01" },
  { company: "former-only-co", person: "former-b", isCurrent: false, startDate: "2015-01-01" },
  { company: "former-only-co", person: "former-c", isCurrent: false, startDate: "2016-01-01" },

  { company: "target-with-contacts-co", person: "target-employee", isCurrent: true, startDate: "2022-01-01" },

  // target-empty-co deliberately has no roles.
];

/**
 * What the fixture MEANS, declared independently of either engine.
 *
 * Without this, two implementations wrong in the same way agree and the parity
 * assertions pass. Every line names the subtlety it pins.
 */
const EXPECTED_COUNTS: Record<string, Counts> = {
  // current: boomeranger (former+current collapses to current) + prospect-current.
  // former: former-once + prospect-former — NOT boomeranger, whose former role
  //   is overridden by the current one, and NOT either bench person.
  // bench: bench-current + bench-former, neither of which appears above.
  // currentProspect: prospect-current only; prospect-former is current at nothing.
  // A foreign tenant's contact also holds a current role here and is excluded.
  acme: { current: 2, former: 2, bench: 2, currentProspect: 1 },
  // Two former rows, one person.
  "twice-former-co": { current: 0, former: 1, bench: 0, currentProspect: 0 },
  // Bench containment: a current bench role is neither current nor former.
  "bench-only-co": { current: 0, former: 0, bench: 1, currentProspect: 0 },
  "prospect-only-co": { current: 1, former: 0, bench: 0, currentProspect: 1 },
  // Current but `active`: counted current, never a current prospect.
  "active-only-co": { current: 1, former: 0, bench: 0, currentProspect: 0 },
  "former-only-co": { current: 0, former: 3, bench: 0, currentProspect: 0 },
  "target-with-contacts-co": { current: 1, former: 0, bench: 0, currentProspect: 0 },
};

/** Every (scope, minContacts) pair the selection rule is compared over. */
const SELECTION_CASES: Array<{ scope: CompanyScope; minContacts: number }> = [
  { scope: "targets", minContacts: 1 },
  { scope: "pursuing", minContacts: 1 },
  { scope: "in_play", minContacts: 1 },
  // minContacts only bites in 'all'. 0 admits the bench-only company (whose
  // current+former is 0); 2 and 4 straddle former-only-co's 3 and acme's 4.
  { scope: "all", minContacts: 0 },
  { scope: "all", minContacts: 1 },
  { scope: "all", minContacts: 2 },
  { scope: "all", minContacts: 4 },
];

// ── Harness ───────────────────────────────────────────────────────────

interface Counts {
  current: number;
  former: number;
  bench: number;
  currentProspect: number;
}

interface CountsRow {
  company_id: number;
  current_count: number;
  former_count: number;
  bench_count: number;
  current_prospect_count: number;
}

/** The per-person shape the replaced client-side sweep read. */
interface EmploymentRow {
  company_id: number;
  contact_id: number;
  is_current: boolean;
  contacts: { network_status: string };
}

interface Agg {
  current: Set<number>;
  former: Set<number>;
  bench: Set<number>;
  currentProspect: Set<number>;
}

/**
 * The TS half: a transcription of the aggregation loop in `getCompanies`
 * (src/lib/company-queries.ts) — the JS rule the RPC is a port of. Kept as a
 * loop over rows rather than a formula, because the loop is what the SQL claims
 * to reproduce.
 */
function aggregate(rows: EmploymentRow[]): Map<number, Agg> {
  const aggByCompany = new Map<number, Agg>();
  for (const row of rows) {
    let agg = aggByCompany.get(row.company_id);
    if (!agg) {
      agg = { current: new Set(), former: new Set(), bench: new Set(), currentProspect: new Set() };
      aggByCompany.set(row.company_id, agg);
    }
    if (row.contacts.network_status === "bench") {
      agg.bench.add(row.contact_id);
    } else {
      (row.is_current ? agg.current : agg.former).add(row.contact_id);
      if (row.is_current && row.contacts.network_status === "prospect") {
        agg.currentProspect.add(row.contact_id);
      }
    }
  }
  // A boomeranger is current, not former.
  for (const agg of aggByCompany.values()) {
    for (const id of agg.current) agg.former.delete(id);
  }
  return aggByCompany;
}

let svc: Db;
let tenant: Tenant;
let outsider: Tenant;
const companyIdByKey = new Map<string, number>();
const companyKeyById = new Map<number, string>();
const contactIdByKey = new Map<string, number>();
/** The TS side's full, unfiltered aggregate over the tenant's own rows. */
let tsAgg = new Map<number, Agg>();
/** What the tenant client actually returned, for the shared-input guard. */
let employmentRows: EmploymentRow[] = [];

function keyOf(companyId: number): string {
  return companyKeyById.get(companyId) ?? `unknown-company-${companyId}`;
}

function targetIds(): number[] {
  return TARGET_COMPANIES.map((k) => companyIdByKey.get(k)!);
}

/**
 * Call the RPC as the signed-in user. Deliberately the tenant's session client
 * and not `serviceClient()`: the function is `security invoker` and filters on
 * `auth.uid()`, which is NULL under the service-role key — every assertion here
 * would then compare two empty sets and pass.
 */
async function rpcCounts(
  scope: CompanyScope,
  minContacts: number,
  extras: number[],
): Promise<CountsRow[]> {
  const { data, error } = await tenant.client.rpc("company_network_counts", {
    p_scope: scope,
    p_min_contacts: minContacts,
    p_extra_company_ids: extras,
  });
  if (error) {
    throw new Error(`company_network_counts(${scope}, ${minContacts}): ${error.message}`);
  }
  return (data ?? []) as CountsRow[];
}

/** Counts from an RPC response, keyed by fixture company key. */
function sqlCountsByKey(rows: CountsRow[]): Record<string, Counts> {
  return Object.fromEntries(
    rows.map((r) => [
      keyOf(Number(r.company_id)),
      {
        current: Number(r.current_count),
        former: Number(r.former_count),
        bench: Number(r.bench_count),
        currentProspect: Number(r.current_prospect_count),
      },
    ]),
  );
}

/** Counts from the TS aggregation, keyed by fixture company key. */
function tsCountsByKey(agg: Map<number, Agg>): Record<string, Counts> {
  return Object.fromEntries(
    [...agg].map(([id, a]) => [
      keyOf(id),
      {
        current: a.current.size,
        former: a.former.size,
        bench: a.bench.size,
        currentProspect: a.currentProspect.size,
      },
    ]),
  );
}

async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<{ id: number }[]> {
  const { data, error } = await (svc as Db).from(table as never).insert(rows as never).select("id");
  if (error) throw new Error(`seed insert into ${table} failed: ${error.message}`);
  return (data as unknown as { id: number }[]) ?? [];
}

beforeAll(async () => {
  svc = serviceClient();
  tenant = await createTenant("cnc-owner");
  // A second tenant with a contact at `acme`. The RPC's own `auth.uid()` filter
  // and the tenant client's RLS must each exclude it; `EXPECTED_COUNTS.acme`
  // is what catches a leak that both halves made together.
  outsider = await createTenant("cnc-outsider");

  // Seeded through the service client (RLS bypassed): scaffolding, not the
  // behavior under test — the same rationale as helpers/tenant-graph.ts.
  const companies = await insertRows(
    "companies",
    COMPANIES.map((key) => ({ name: uniq(`CNC ${key}`) })),
  );
  COMPANIES.forEach((key, i) => {
    companyIdByKey.set(key, companies[i].id);
    companyKeyById.set(companies[i].id, key);
  });

  const personKeys = Object.keys(PEOPLE);
  const contacts = await insertRows(
    "contacts",
    personKeys.map((key) => ({
      user_id: tenant.userId,
      name: uniq(`CNC ${key}`),
      network_status: PEOPLE[key],
    })),
  );
  personKeys.forEach((key, i) => contactIdByKey.set(key, contacts[i].id));

  await insertRows(
    "contact_companies",
    ROLES.map((r) => ({
      contact_id: contactIdByKey.get(r.person)!,
      company_id: companyIdByKey.get(r.company)!,
      is_current: r.isCurrent,
      start_date: r.startDate,
      title: `${r.person} @ ${r.company}`,
    })),
  );

  const [foreign] = await insertRows("contacts", [
    { user_id: outsider.userId, name: uniq("CNC outsider"), network_status: "active" },
  ]);
  await insertRows("contact_companies", [
    {
      contact_id: foreign.id,
      company_id: companyIdByKey.get("acme")!,
      is_current: true,
      start_date: "2021-06-01",
      title: "outsider @ acme",
    },
  ]);

  // The TS half reads the same seeded rows the RPC aggregates, through the
  // tenant's own RLS-scoped client — the sweep CAR-229 replaced. Unfiltered by
  // company on purpose: the tenant is fresh, so this is the whole network, and
  // the row-count guard below is therefore meaningful.
  const { data, error } = await tenant.client
    .from("contact_companies")
    .select("company_id, contact_id, is_current, contacts!inner(user_id, network_status)")
    .eq("contacts.user_id", tenant.userId)
    .order("company_id")
    .order("contact_id")
    .order("id");
  if (error) throw new Error(`employment read failed: ${error.message}`);
  employmentRows = (data ?? []) as unknown as EmploymentRow[];
  tsAgg = aggregate(employmentRows);
}, 120_000);

afterAll(async () => {
  // Contacts and their contact_companies rows cascade with the users; companies
  // are shared catalog and do not, so they are removed explicitly.
  await deleteTenant(tenant.userId);
  await deleteTenant(outsider.userId);
  const ids = [...companyIdByKey.values()];
  if (ids.length > 0) await svc.from("companies").delete().in("id", ids);
}, 120_000);

// ── Assertions ────────────────────────────────────────────────────────

describe("company_network_counts() shares its input with the TS aggregation", () => {
  it("hands both halves exactly the fixture's rows, and nobody else's", () => {
    // The guard that keeps everything below from agreeing vacuously: if this
    // read came back short (or empty, or carrying the outsider's row), the
    // parity assertions would compare two aggregates over the wrong rows.
    const seen = employmentRows
      .map((r) => `${keyOf(r.company_id)}|${r.contact_id}|${r.is_current}`)
      .sort();
    const expected = ROLES.map(
      (r) => `${r.company}|${contactIdByKey.get(r.person)}|${r.isCurrent}`,
    ).sort();
    expect(seen).toEqual(expected);
  });
});

describe("company_network_counts() agrees with the TS aggregation", () => {
  it("produces the identical per-company counts for the shared fixture", async () => {
    // scope 'all' + minContacts 0 is the unfiltered aggregate: every company
    // with any employment row, filter clause satisfied for all of them.
    //
    // Compared as ONE object rather than in a loop so a failure prints EVERY
    // disagreement at once — the point is spotting drift, and drift usually
    // moves more than a single company.
    const fromSql = sqlCountsByKey(await rpcCounts("all", 0, []));
    const fromTs = tsCountsByKey(tsAgg);
    expect(fromSql).toEqual(fromTs);
  });

  it("both engines match the fixture's own expectations", async () => {
    // Parity alone is satisfied by two implementations wrong in the SAME way.
    // This is what pins the three subtleties the SQL header calls out:
    // bench containment, multi-role collapse with current winning, and
    // former_count counting people rather than is_current = false rows.
    const fromSql = sqlCountsByKey(await rpcCounts("all", 0, []));
    const fromTs = tsCountsByKey(tsAgg);

    expect(fromSql).toEqual(EXPECTED_COUNTS);
    expect(fromTs).toEqual(EXPECTED_COUNTS);
  });

  it("counts only the signed-in user's contacts", async () => {
    // The RPC's `where c.user_id = auth.uid()` is the SQL-side statement of a
    // rule the TS side gets from RLS plus an explicit user filter. A leak here
    // would show up as a third current contact at acme.
    const acme = sqlCountsByKey(await rpcCounts("all", 0, []))["acme"];
    expect(acme).toEqual(EXPECTED_COUNTS["acme"]);
  });
});

describe("company_network_counts()'s scope filter agrees with selectCompanyIds()", () => {
  it("selects the identical company set for every scope and minContacts", async () => {
    // The assertion that catches the SQL WHERE clause and the TS rule drifting
    // apart. The TS side is given the FULL unfiltered counts, exactly as
    // getCompanies does before re-applying the rule.
    const tsSizes = new Map(
      [...tsAgg].map(([id, a]) => [
        id,
        {
          current: { size: a.current.size },
          former: { size: a.former.size },
          currentProspect: { size: a.currentProspect.size },
        },
      ]),
    );

    const fromSql: Record<string, string[]> = {};
    const fromTs: Record<string, string[]> = {};
    for (const { scope, minContacts } of SELECTION_CASES) {
      const label = `${scope}@min${minContacts}`;
      const rows = await rpcCounts(scope, minContacts, targetIds());
      fromSql[label] = rows.map((r) => keyOf(Number(r.company_id))).sort();
      fromTs[label] = selectCompanyIds(scope, targetIds(), tsSizes, minContacts).map(keyOf).sort();
    }

    // One assertion over the whole table, so a drifted clause reports every
    // scope it broke rather than only the first.
    expect(fromSql).toEqual(fromTs);
  });

  it("returns a targeted company that has no contacts, with zero counts", async () => {
    // p_extra_company_ids exists so a target is shown regardless of contact
    // count ("must keep their counts", per the migration header). A target the
    // user has not met anyone at yet is the case that exercises it, and it is
    // also the one place selectCompanyIds is unconditional: it seeds its result
    // with every target id before looking at any aggregate.
    const rows = await rpcCounts("targets", 1, targetIds());
    expect(sqlCountsByKey(rows)).toEqual({
      "target-with-contacts-co": EXPECTED_COUNTS["target-with-contacts-co"],
      "target-empty-co": { current: 0, former: 0, bench: 0, currentProspect: 0 },
    });
  });
});

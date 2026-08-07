import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serviceClient, createTenant, deleteTenant, uniq, type Tenant, type Db } from "./helpers/stack";
import { purgeScrapedData } from "@/lib/data-retention";
import { paginateAll } from "@/lib/data/postgrest";
// company-queries.ts carries its OWN lazy client seam, separate from
// src/lib/data/client.ts's. Injecting the wrong one leaves it on the browser
// singleton, which answers an unauthenticated read with zero rows rather than
// an error — a test written against that would have "passed" on an empty list.
import { getCompanyDetail, getContactStages, setCompanyQueriesClient } from "@/lib/company-queries";

/**
 * CAR-207: the 1000-row PostgREST ceiling, against a real PostgREST.
 *
 * This tier exists for exactly this. A mock answers whatever it is told to,
 * so a mocked "1001 rows" test proves the mock paginates; only the real stack
 * enforces the cap, and the cap is silent — no error, no flag, just a short
 * array that every downstream line treats as the whole truth.
 *
 * Two live consequences are pinned here, and they fail in opposite directions:
 *
 *   - the retention purge UNDER-deletes when its bundle list truncates, and
 *     OVER-deletes when its subscription list does. The second is data loss:
 *     the threshold it computes is the floor across active subscribers, so
 *     dropping the subscriber that holds the floor RAISES the threshold and
 *     hard-deletes rows that subscriber still needs.
 *   - a company's people list truncates AND reorders, because the read asked
 *     for 2000 rows with no ORDER BY, and without one Postgres guarantees
 *     nothing about which 1000 come back.
 */

const OVER_CEILING = 1001;

let svc: Db;
let tenantA: Tenant;
let tenantB: Tenant;
/** data_bundles is a shared catalog with no user_id, so it does not cascade
 *  away with the tenants; left behind, 1001 rows per run would slow the
 *  purge's per-bundle delete loop for every later run. */
const seededBundleIds: number[] = [];

/** Insert in batches: one 1001-row statement is fine, but the URL is not. */
async function insertMany(table: string, rows: Record<string, unknown>[]): Promise<{ id: number }[]> {
  const out: { id: number }[] = [];
  for (let i = 0; i < rows.length; i += 250) {
    const { data, error } = await (svc as unknown as Db)
      .from(table as never)
      .insert(rows.slice(i, i + 250) as never)
      .select("id");
    if (error) throw new Error(`seed insert into ${table} failed: ${error.message}`);
    out.push(...((data as unknown as { id: number }[]) ?? []));
  }
  return out;
}

beforeAll(async () => {
  svc = serviceClient();
  tenantA = await createTenant("ceiling-a");
  tenantB = await createTenant("ceiling-b");
}, 60_000);

afterAll(async () => {
  await deleteTenant(tenantA.userId);
  await deleteTenant(tenantB.userId);
  for (let i = 0; i < seededBundleIds.length; i += 250) {
    await svc.from("data_bundles").delete().in("id", seededBundleIds.slice(i, i + 250));
  }
}, 120_000);

describe("retention purge past the 1000-row ceiling (CAR-207)", () => {
  it("purges the last bundle, and spares rows the truncated-away subscriber still needs", async () => {
    // 1001 published bundles, so the bundle list itself overflows one page.
    const bundles = await insertMany(
      "data_bundles",
      Array.from({ length: OVER_CEILING }, (_, i) => ({
        slug: uniq(`ceil-${i}`),
        name: `Ceiling Bundle ${i}`,
        status: "published",
        version: 9,
        published_at: new Date().toISOString(),
      })),
    );
    seededBundleIds.push(...bundles.map((b) => b.id));
    const firstBundle = bundles[0].id;
    const lastBundle = bundles[bundles.length - 1].id;

    // Tenant A subscribes to all of them at synced_version 5. That alone is
    // 1001 subscription rows, so the subscription list overflows too.
    await insertMany(
      "bundle_subscriptions",
      bundles.map((b) => ({
        user_id: tenantA.userId,
        bundle_id: b.id,
        status: "active",
        synced_version: 5,
      })),
    );
    // Tenant B subscribes to the FIRST bundle only, and has synced nothing, so
    // it holds that bundle's floor: nothing there is safe to delete.
    //
    // Inserted last, so it is physically last in the heap. That is what put it
    // past the old read's cut: the pre-fix query carried no `.order()` at all,
    // so PostgREST truncated one 1000-row response in whatever order the plan
    // emitted, which for this shape is physical order under both a Seq Scan and
    // a Bitmap Heap Scan. (An earlier version of this comment claimed the row
    // landed on "page two" of an id-ordered read. There were no pages and no
    // ordering before the fix; the review that caught it also ran the pre-fix
    // function against this exact fixture and confirmed it deletes `pinnedByB`.)
    await insertMany("bundle_subscriptions", [
      { user_id: tenantB.userId, bundle_id: firstBundle, status: "active", synced_version: 0 },
    ]);

    const prospect = (bundleId: number, removedIn: number) => ({
      bundle_id: bundleId,
      linkedin_url: `https://linkedin.com/in/${uniq("ceil")}`,
      payload: {},
      payload_hash: uniq("hash"),
      version_added: 1,
      version_updated: 1,
      version_last_seen: 1,
      removed_in_version: removedIn,
    });
    const [pinnedByB] = await insertMany("bundle_prospects", [prospect(firstBundle, 3)]);
    const [onLastBundle] = await insertMany("bundle_prospects", [prospect(lastBundle, 3)]);
    const [notYetSynced] = await insertMany("bundle_prospects", [prospect(lastBundle, 12)]);

    // Plan-independent proof that the walk itself is complete, asserted directly
    // rather than inferred from a downstream delete. Everything below depends on
    // the read seeing all 1002 subscriptions, and a truncated read would still
    // satisfy some of those assertions under some query plans.
    const allSubs = await paginateAll<{ bundle_id: number }>(async (from, to) => {
      const { data, error } = await svc
        .from("bundle_subscriptions")
        .select("bundle_id, synced_version")
        .eq("status", "active")
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      return data as { bundle_id: number }[] | null;
    });
    expect(allSubs.length).toBe(OVER_CEILING + 1);

    const result = await purgeScrapedData({ service: svc });
    // Asserted, not assumed: purgeScrapedData swallows a step's throw into
    // `errors` and returns normally, so without this an aborted purge reads
    // exactly like a purge that decided to delete nothing.
    expect(result.errors).toEqual([]);

    const survives = async (id: number) => {
      const { data } = await svc.from("bundle_prospects").select("id").eq("id", id).maybeSingle();
      return data != null;
    };

    // Under-deletion: bundle 1001 falls past the bundle read's first page, so
    // it was never visited and its dead row lived forever.
    expect(await survives(onLastBundle.id), "soft-removed row on the 1001st bundle").toBe(false);
    // Over-deletion, the data-loss direction: tenant B has synced nothing, so
    // the floor for bundle 1 is 0 and NOTHING there is safe to drop. Miss B's
    // row and the floor reads 5, which deletes the removal delta B has not
    // applied yet — B would then never learn the prospect was removed.
    expect(await survives(pinnedByB.id), "row pinned by the page-two subscriber").toBe(true);
    // And the ordinary guard still holds: 12 > 5, nobody has synced past it.
    expect(await survives(notYetSynced.id), "row above every subscriber's version").toBe(true);
  }, 180_000);
});

describe("company detail past the 1000-row ceiling (CAR-207)", () => {
  it("returns every employment row, in the same order on every load", async () => {
    const { data: company, error: companyErr } = await svc
      .from("companies")
      .insert({ name: uniq("Ceiling Co") })
      .select("id")
      .single();
    if (companyErr || !company) throw new Error(`company seed: ${companyErr?.message}`);

    const contacts = await insertMany(
      "contacts",
      Array.from({ length: OVER_CEILING }, (_, i) => ({
        user_id: tenantA.userId,
        name: `Ceiling Person ${String(i).padStart(4, "0")}`,
      })),
    );
    await insertMany(
      "contact_companies",
      contacts.map((c) => ({
        contact_id: c.id,
        company_id: company.id,
        is_current: true,
        title: "PM",
      })),
    );

    // The tenant's own RLS-scoped client, which is what the app injects.
    setCompanyQueriesClient(tenantA.client as never);

    const first = await getCompanyDetail(tenantA.userId, company.id);
    const second = await getCompanyDetail(tenantA.userId, company.id);
    if (!first || !second) throw new Error("getCompanyDetail returned null");

    const names = (detail: NonNullable<typeof first>) =>
      [...detail.current, ...detail.former, ...detail.bench].map((p) => p.name);

    // Truncation: `.limit(2000)` asked for twice what PostgREST will return, so
    // 1001 people came back as 1000 and the page reported a smaller company.
    expect(names(first)).toHaveLength(OVER_CEILING);
    // Instability: with no ORDER BY the server may return a different window
    // each time, so two loads of the same page disagreed about who works there.
    // Compared as a sequence, not a set: order is half of what was unspecified.
    expect(names(second)).toEqual(names(first));
  }, 180_000);
});

/**
 * The truncation DOWNSTREAM of the one above, found by the CAR-207 review.
 *
 * `chunked` bounds the URL at 200 ids; it does not bound the RESPONSE. Every
 * leg inside a chunk was a single unpaginated request, and 200 contacts carry
 * well over 1000 rows between them. These legs are pure Set membership, so a
 * dropped row does not degrade a stage, it INVERTS one: a contact who has been
 * called or DM'd reads `not_contacted` and re-enters outreach queues.
 *
 * Integration-tier because the whole failure is PostgREST's silent row cap: it
 * returns 1000 rows with `error: null`, which no mock reproduces and `must()`
 * cannot catch.
 */
describe("contact stages past the 1000-row ceiling (CAR-207 review)", () => {
  it("classifies every contact as contacted when each has interactions", async () => {
    // 200 is one full `chunked` slice; 6 each is 1200 rows, comfortably past
    // the cap. Before the fix this returned 1000 rows covering ~168 contacts,
    // so ~32 were reported as never contacted.
    const PEOPLE = 200;
    const PER_PERSON = 6;

    const contacts = await insertMany(
      "contacts",
      Array.from({ length: PEOPLE }, (_, i) => ({
        user_id: tenantA.userId,
        name: `Stage Person ${String(i).padStart(4, "0")}`,
      })),
    );
    await insertMany(
      "interactions",
      contacts.flatMap((c) =>
        Array.from({ length: PER_PERSON }, (_, j) => ({
          contact_id: c.id,
          interaction_type: "coffee",
          interaction_date: new Date(Date.UTC(2026, 0, j + 1)).toISOString(),
        })),
      ),
    );

    setCompanyQueriesClient(tenantA.client as never);
    const stages = await getContactStages(
      tenantA.userId,
      contacts.map((c) => ({ id: c.id })),
    );

    // Every leg ran without a 400, which is itself load-bearing: two of them
    // (meeting_contacts, calendar_event_contacts) have no `id` column, so they
    // paginate on their composite key. Ordering by a column that does not exist
    // would reject the request rather than fail quietly.
    expect(stages.size).toBe(PEOPLE);
    const notContacted = [...stages.entries()].filter(([, s]) => s.stage === "not_contacted");
    expect(notContacted).toEqual([]);
  }, 180_000);
});

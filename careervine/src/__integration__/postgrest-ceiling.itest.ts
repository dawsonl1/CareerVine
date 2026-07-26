import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serviceClient, createTenant, deleteTenant, uniq, type Tenant, type Db } from "./helpers/stack";
import { purgeScrapedData } from "@/lib/data-retention";
// company-queries.ts carries its OWN lazy client seam, separate from
// src/lib/data/client.ts's. Injecting the wrong one leaves it on the browser
// singleton, which answers an unauthenticated read with zero rows rather than
// an error — a test written against that would have "passed" on an empty list.
import { getCompanyDetail, setCompanyQueriesClient } from "@/lib/company-queries";

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
    // Tenant B subscribes to the FIRST bundle only, and has synced nothing.
    // Inserted last, so its id puts it on page two of the subscription read —
    // which is precisely where the old unpaginated read stopped looking.
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

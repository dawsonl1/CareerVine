/**
 * Flow 12 (CAR-268): a company page you have already opened comes back from
 * cache when you return from one of its contacts, EXCEPT when you changed
 * something it shows.
 *
 * ── What this proves ──────────────────────────────────────────────────────
 *
 * Three properties of one round trip (company → contact → back), each measured
 * on the wire with `helpers/request-budget.ts` rather than inferred from how
 * fast the roster appeared:
 *
 *  1. THE ROSTER IS NOT RE-READ. `fetchCompanyScopes` is the expensive half of
 *     this page (getCompanyDetail's two waves plus getContactStages' eight
 *     legs), and returning must not pay for it again. Asserted per ENDPOINT, not
 *     as a total: `supabase:/rest/v1/companies`, `/company_locations`,
 *     `/contact_companies` and `/contact_schools` are read by that call and by
 *     nothing else on the return path, so their absence is the roster read's
 *     absence.
 *  2. THE PIPELINE *IS* RE-READ. This is the design decision the ticket turns
 *     on, so it is pinned rather than merely permitted: `loadPipeline` is
 *     deliberately outside the cache because `usePipelineAutosave` flushes on
 *     unmount, and a snapshot stamped before that flush would show the user a
 *     note that is sitting in the database. `supabase:/rest/v1/pipeline_cycles`
 *     is loadPipeline's and only loadPipeline's, so its PRESENCE is that read.
 *     If it ever goes quiet, this file fails and someone has to say why.
 *  3. A WRITE INVALIDATES. Adding the seeded prospect to the network from the
 *     contact page calls `invalidateCompanyScopes()`, and the return then makes
 *     the roster read it skipped in test 1. Both halves are asserted: the
 *     request fires, AND the roster comes back showing six people under "Your
 *     network" with no "Prospects" group. The second half is what a
 *     request-count-only test would miss, and it is the failure the user would
 *     actually see: a roster contradicting the action they just took.
 *
 * A fourth test pins the ORDER: with the pipeline's read held open, the roster
 * is fully painted while the pipeline column still reads "Loading pipeline…".
 * Before CAR-268 the page gated on both, so a held pipeline read meant a page
 * that said "Loading…" and nothing else.
 *
 * ── Every assertion here was falsified before it was kept ─────────────────
 *
 * Each probe was applied to `src/`, the suite re-run, and the source restored:
 *
 *   `COMPANY_SCOPES_TTL_MS = 0` (cache always misses)  → property 1 fails, 5
 *      roster requests instead of 0.
 *   `loadPipeline` memoized in a module Map (the exact regression property 2
 *      guards against) → property 2 fails, 0 pipeline requests instead of 3.
 *   `invalidateCompanyScopes()` deleted from `handleActivate` → property 3
 *      fails BOTH ways: 0 roster requests, and the returned roster still shows
 *      the person under "Prospects". The second was checked separately, by
 *      softening the first so the run reached it.
 *   the render gate widened back to `|| !state` → the fourth test fails; with
 *      the pipeline held the roster never paints at all.
 *
 * That last probe is also why `openCompanyCold` asserts both endpoint sets are
 * non-empty on a cold load. An absence assertion over endpoint names nothing
 * ever requests passes for the wrong reason, and a typo in either list would
 * otherwise be indistinguishable from the feature working.
 *
 * ── What this does NOT prove ──────────────────────────────────────────────
 *
 * IT IS NOT A TEST OF THE TTL. `COMPANY_SCOPES_TTL_MS` is two minutes and every
 * measurement below happens inside a few seconds of the write that seeded the
 * entry, so expiry is never exercised. `src/lib/list-cache.ts`'s unit tests own
 * that; a two-minute wait here would be an arbitrary sleep for no new coverage.
 *
 * IT PROVES NOTHING ABOUT A HARD RELOAD. The store is module scope and dies with
 * the document (deliberately — see `list-cache.ts`), so every measurement here
 * is a client-side transition. `measurePageLoad`'s `about:blank` park is what
 * makes the cold baseline genuinely cold for the same reason.
 *
 * IT DOES NOT COVER THE OTHER ELEVEN INVALIDATION SITES. `invalidateCompanyScopes`
 * has twelve call sites across eight modules (contact-edit-modal,
 * contact-profile-card, timeline-detail-modal, compose-email-modal,
 * conversation-modal, discovery-card, use-pipeline-autosave, and the company
 * page's own tier move). Test 3 drives ONE of them end to end. The rest are
 * plain calls to the same no-argument sweep, and the thing that could genuinely
 * break — the sweep clearing an entry a component with no `userId` in scope
 * cannot name — is what this exercises. A test per call site would re-measure
 * the same function; `src/__tests__/company-detail-cache.test.ts` covers the
 * sweep's own semantics.
 *
 * THE RETURN IS NOT ZERO-REQUEST, and must not be asserted as such — which is
 * the one thing this file could NOT copy from `companies-back-nav.spec.ts`. Two
 * things on this page read on every mount by design: `loadPipeline` (property 2
 * — that is the point) and `DiscoveryCard`'s `GET /api/discovery/candidates`
 * probe. So the total assertion below is a ceiling relative to the cold load,
 * and the sharp assertions are the per-endpoint ones on either side of it.
 *
 * ── Why this file mints its own tenant ────────────────────────────────────
 *
 * The same documented exception `request-budget.spec.ts` and
 * `companies-back-nav.spec.ts` take. It needs a company with a whole roster and
 * a target row, which is volume the shared single-worker tenant must not carry,
 * and it flips a contact's tier, which is damage wider than an `afterEach`
 * restore. It also seeds the shared `companies` catalog, which does not cascade
 * on `deleteTenant`, so `afterAll` removes those rows itself.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import {
  createTenant,
  deleteTenant,
  serviceClient,
  completeOnboarding,
  mintSessionUrl,
  seedGmailConnection,
  uniq,
  type Tenant,
} from "./helpers/tenant";
import {
  formatTally,
  measurePageLoad,
  tallyRequests,
  type RequestTally,
} from "./helpers/request-budget";
import type { Database } from "@/lib/database.types";

type TableName = keyof Database["public"]["Tables"] & string;
type Insertable<T extends TableName> = Database["public"]["Tables"][T]["Insert"];

// Signed out at the project level: this file mints its own session per test
// rather than inheriting the shared one.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Five in the network plus one prospect.
 *
 * The prospect is not decoration: it is what puts a "Prospects" group on the
 * roster and an "Add to my network" button on its contact page, which together
 * make the invalidation in test 3 observable as a VISIBLE change rather than
 * only as a request count. Five active is enough that the group counts move
 * (5 → 6) instead of one group simply vanishing.
 */
const ACTIVE = 5;

/**
 * Tables read by `fetchCompanyScopes` and by nothing else this page mounts.
 *
 * `target_companies` is deliberately absent from this list even though the
 * roster reads it: `loadPipeline` reads it too, so it cannot discriminate.
 * These four can. `companies` and `company_locations` are wave-1 reads that
 * fire on every call regardless of data; `contact_companies` and
 * `contact_schools` fire because the roster is non-empty.
 */
const ROSTER_ONLY = [
  "GET supabase:/rest/v1/companies",
  "GET supabase:/rest/v1/company_locations",
  "GET supabase:/rest/v1/contact_companies",
  "GET supabase:/rest/v1/contact_schools",
] as const;

/**
 * `loadPipeline`'s second read, and nobody else's.
 *
 * It is reached only when the company has at least one `target_companies` row,
 * which is why `beforeAll` seeds one — without it `loadPipeline` returns early
 * and property 2 would be asserted against a read that never happens.
 */
const PIPELINE_ONLY = ["GET supabase:/rest/v1/pipeline_cycles"] as const;

let tenant: Tenant;
let companyId: number;
let companyName: string;
let namePrefix: string;
/** The seeded prospect, whose tier test 3 flips. */
let prospectName: string;
/** Shared-catalog rows this file owns and must remove itself — see afterAll. */
let seededCompanyIds: number[] = [];

test.beforeAll(async () => {
  tenant = await createTenant("e2e-cocache");
  const svc = serviceClient();
  // Premium and past onboarding, so nothing renders a full-screen step over the
  // page (see `completeOnboarding`).
  await seedGmailConnection(tenant.userId);
  await completeOnboarding(tenant.userId);

  const insert = async <T extends TableName>(table: T, payload: Insertable<T>[]) => {
    const { error } = await svc.from(table).insert(payload as never);
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  };
  // `.select("id")` on a generic table resolves to a union across every table,
  // several of which have no `id`, so the row type is asserted through
  // `unknown`. Every call below inserts into a table that has one.
  const idsOf = async <T extends TableName>(
    table: T,
    payload: Insertable<T>[],
  ): Promise<number[]> => {
    const { data, error } = await svc
      .from(table)
      .insert(payload as never)
      .select("id");
    if (error || !data) throw new Error(`seed ${table}: ${error?.message ?? "no rows"}`);
    return (data as unknown as { id: number }[]).map((r) => r.id);
  };

  namePrefix = uniq("Rosterite");
  prospectName = `${namePrefix} Prospect`;
  companyName = uniq("Cache Co");

  // Nobody is `bench`. That is load-bearing rather than incidental: a bench
  // contact puts `getFreshJobChangeContactIds` on every mount, deliberately
  // OUTSIDE the cached payload, and its read would then land in the return's
  // tally as noise the endpoint assertions would have to carve around.
  const contactIds = await idsOf("contacts", [
    ...Array.from({ length: ACTIVE }, (_, i) => ({
      user_id: tenant.userId,
      name: `${namePrefix} ${i}`,
      network_status: "active",
      headline: "Product Manager",
    })),
    {
      user_id: tenant.userId,
      name: prospectName,
      network_status: "prospect",
      headline: "Product Manager",
    },
  ]);
  await insert(
    "contact_emails",
    contactIds.map((id, i) => ({
      contact_id: id,
      email: `${uniq(`rosterite-${i}`)}@example.com`,
      is_primary: true,
    })),
  );

  [companyId] = await idsOf("companies", [{ name: companyName }]);
  seededCompanyIds = [companyId];
  await insert(
    "contact_companies",
    contactIds.map((contactId) => ({
      contact_id: contactId,
      company_id: companyId,
      is_current: true,
      title: "Product Manager",
    })),
  );
  // The company-wide scope row. Without it `loadPipeline` short-circuits before
  // `pipeline_cycles` and PIPELINE_ONLY would be unobservable.
  await insert("target_companies", [
    {
      user_id: tenant.userId,
      company_id: companyId,
      location_id: null,
      is_targeted: true,
      status: "researching",
    },
  ]);
});

test.afterAll(async () => {
  // The teardown project also sweeps `itest-e2e-*`, so a crash before here still
  // converges; this keeps the stack clean within the run.
  if (tenant?.userId) await deleteTenant(tenant.userId);

  // `companies` is the SHARED catalog: deleting the tenant cascades the
  // user-owned rows that point at it (contact_companies, target_companies) but
  // never the company itself, and nothing else sweeps it. Ordered after
  // deleteTenant so the FK dependents are already gone.
  if (seededCompanyIds.length > 0) {
    await serviceClient().from("companies").delete().in("id", seededCompanyIds);
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto(await mintSessionUrl(tenant.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

/** The roster panel — the `<section>` headed "Contacts". */
const roster = (page: Page): Locator =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Contacts", level: 2 }) });

/** A person's row in the roster. The card has no role; its name is a `<span>`. */
const rosterRow = (page: Page, name: string): Locator =>
  roster(page).getByText(name, { exact: true });

const backButton = (page: Page) => page.getByRole("button", { name: "Back", exact: true });

/** How many of `keys` were requested during the measured window. */
function hits(tally: RequestTally, keys: readonly string[]): number {
  return keys.reduce((n, key) => n + (tally.byEndpoint.get(key) ?? 0), 0);
}

/**
 * Load the company page from scratch and tally what that costs.
 *
 * `measurePageLoad` parks on `about:blank` first, which also drops the
 * in-memory cache — this is the COLD number every return is compared against,
 * so it has to start from a document that has never held the roster.
 */
async function openCompanyCold(page: Page): Promise<RequestTally> {
  const tally = await measurePageLoad(page, `/companies/${companyId}`);
  await expect(page.getByRole("heading", { name: "Contacts", level: 2 })).toBeVisible();
  await expect(rosterRow(page, `${namePrefix} 0`)).toBeVisible();

  // Both endpoint sets must be REACHABLE on this page, or the assertions that
  // read them on the return are asserting about names nothing ever requests.
  expect(
    hits(tally, ROSTER_ONLY),
    `a cold company load must read the roster, or ROSTER_ONLY names tables this page never ` +
      `requests and its absence proves nothing:\n${formatTally(tally.byEndpoint)}`,
  ).toBeGreaterThanOrEqual(ROSTER_ONLY.length);
  expect(
    hits(tally, PIPELINE_ONLY),
    `a cold company load must read the pipeline, or PIPELINE_ONLY is unobservable — check ` +
      `that beforeAll still seeds a target_companies row:\n${formatTally(tally.byEndpoint)}`,
  ).toBeGreaterThan(0);
  return tally;
}

/** Open the seeded contact's page from the roster and wait for it to go quiet. */
async function visitContact(page: Page, name: string): Promise<void> {
  await rosterRow(page, name).click();
  await expect(page).toHaveURL(/\/contacts\/\d+/);
  await expect(backButton(page)).toBeVisible();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  // The contact page's own reads have to finish BEFORE a measured window opens,
  // or they land inside it and the return looks like it refetched.
  await tallyRequests(page, async () => {}, { label: "the contact page" });
}

test("returning from a contact serves the roster from cache and re-reads the pipeline", async ({
  page,
}) => {
  const cold = await openCompanyCold(page);
  await visitContact(page, `${namePrefix} 0`);

  const tally = await tallyRequests(
    page,
    async () => {
      await backButton(page).click();
      await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
      await expect(rosterRow(page, `${namePrefix} 0`)).toBeVisible();
    },
    { label: "returning to the company page" },
  );

  // ── 1. The roster was not re-read ───────────────────────────────────────
  expect(
    hits(tally, ROSTER_ONLY),
    `returning to /companies/${companyId} re-read the roster. It must be served from the ` +
      `in-memory cache (src/lib/company-detail-cache.ts); a cold load of the same page made ` +
      `${cold.total} request(s) in total.\n${formatTally(tally.byEndpoint)}`,
  ).toBe(0);

  // ── 2. The pipeline WAS re-read ─────────────────────────────────────────
  // Pinned, not permitted. Caching this half would silently discard an
  // autosave flush that lands after the cache entry is stamped — see the header
  // of `src/lib/company-detail-cache.ts`. If a change makes this fail, the
  // right response is to reopen that trade-off, not to relax the assertion.
  expect(
    hits(tally, PIPELINE_ONLY),
    `returning to /companies/${companyId} did NOT re-read the pipeline. loadPipeline is ` +
      `deliberately uncached because usePipelineAutosave flushes on unmount.\n` +
      formatTally(tally.byEndpoint),
  ).toBeGreaterThan(0);

  // ── The totals, as a ceiling ────────────────────────────────────────────
  // A ceiling rather than an exact count, because the sharp assertions are the
  // two above: this one only has to fail if the return starts doing something
  // of the same ORDER as a cold load. Half of cold is far more slack than the
  // roster's share of it, so a reintroduced roster read cannot hide under it
  // while the endpoint assertion is also in force.
  expect(
    tally.total,
    `returning made ${tally.total} data request(s) against ${cold.total} for a cold load — ` +
      `too close to paying full price for a page that should only be re-reading its ` +
      `pipeline.\n${formatTally(tally.byEndpoint)}`,
  ).toBeLessThan(cold.total / 2);
});

test("a write from the contact page invalidates the cached roster", async ({ page }) => {
  await openCompanyCold(page);
  // The roster the cache is about to hold: five in the network, one prospect.
  await expect(roster(page).getByText("Prospects", { exact: true })).toBeVisible();
  await expect(rosterRow(page, prospectName)).toBeVisible();

  await visitContact(page, prospectName);

  // `handleActivate` in contact-profile-card.tsx — one of the twelve call sites
  // wired to `invalidateCompanyScopes()`, and the most direct of them.
  await page.getByRole("button", { name: "Add to my network" }).click();
  await expect(page.getByText(`${prospectName} added to your network`)).toBeVisible();
  // The button is the write's own receipt: it renders only while the contact is
  // not `active`, so its disappearance is the refetched contact confirming the
  // row changed. Sequencing the measurement after it keeps the contact page's
  // own re-read out of the window below.
  await expect(page.getByRole("button", { name: "Add to my network" })).toHaveCount(0);
  await tallyRequests(page, async () => {}, { label: "the contact page after the write" });

  const tally = await tallyRequests(
    page,
    async () => {
      await backButton(page).click();
      await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
      await expect(rosterRow(page, prospectName)).toBeVisible();
    },
    { label: "returning after a write" },
  );

  // ── The read the previous test proved does NOT happen ───────────────────
  expect(
    hits(tally, ROSTER_ONLY),
    `a tier change from the contact page must drop the cached roster, so returning re-reads ` +
      `it. invalidateCompanyScopes() is called from handleActivate in ` +
      `src/components/contacts/contact-profile-card.tsx.\n${formatTally(tally.byEndpoint)}`,
  ).toBeGreaterThanOrEqual(ROSTER_ONLY.length);

  // ── ...and the roster on screen agrees with what the user just did ──────
  // The half a request count cannot see. A stale cache would still group this
  // person under "Prospects", which is the roster contradicting the action the
  // user took thirty seconds ago.
  await expect(
    roster(page).getByText("Prospects", { exact: true }),
    "the person was added to the network, so the roster must have no Prospects group left",
  ).toHaveCount(0);
  await expect(roster(page).getByText("Your network", { exact: true })).toBeVisible();
  await expect(
    roster(page).getByText("Your network", { exact: true }).locator("xpath=following-sibling::span[1]"),
    "all six people belong to the network now",
  ).toHaveText(String(ACTIVE + 1));
});

test("the roster paints while the pipeline is still loading", async ({ page }) => {
  // The render gate is what this test is about, and it is only observable while
  // the pipeline read is outstanding — locally a handful of milliseconds, far
  // too short to catch by polling. So the read is HELD rather than waited for.
  // Not an arbitrary delay: the gate is opened by this test the moment it has
  // looked, and the assertion after that proves the hold was the only thing
  // keeping the placeholder on screen.
  let gate: Promise<void> | null = null;
  let openGate: () => void = () => {};
  const holdNextPipelineRead = () => {
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  };
  // `page.route` takes precedence over the `context.route` the networkGuard
  // fixture installs, and this handler always continues, so the guard's
  // loopback pass-through is unaffected. Only the FIRST read after each
  // `holdNextPipelineRead()` waits; later ones pass straight through.
  await page.route("**/rest/v1/pipeline_cycles*", async (route) => {
    const waiting = gate;
    gate = null;
    if (waiting) await waiting;
    await route.continue();
  });

  try {
    // The cold load is already one observation of the property: with the read
    // held, `openCompanyCold` cannot return unless the roster painted without
    // it. The return below is the sharper one — from cache the roster hydrates
    // in a layout effect with no fetch at all, so the ordering stops depending
    // on which of two in-flight reads happens to land first.
    holdNextPipelineRead();
    await openCompanyCold(page);
    openGate();

    await visitContact(page, `${namePrefix} 0`);

    holdNextPipelineRead();
    await backButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));

    // The whole roster, not just the page shell: every seeded person, grouped.
    await expect(rosterRow(page, `${namePrefix} 0`)).toBeVisible();
    await expect(rosterRow(page, prospectName)).toBeVisible();
    await expect(roster(page).getByText("Your network", { exact: true })).toBeVisible();
    // ...while the column that is still reading says so. Before CAR-268 the
    // page gated on both halves, so this commit rendered a bare "Loading…" and
    // not one of the three assertions above could pass. (Falsified: widening
    // the gate back to `|| !state` fails this test.)
    await expect(
      page.getByText("Loading pipeline…"),
      "the roster must not wait on the pipeline read",
    ).toBeVisible();

    openGate();
    // Released rather than abandoned: the placeholder giving way to the real
    // panel is what proves the hold was the only reason it was there, and not
    // some unrelated reason the pipeline never rendered.
    await expect(page.getByText("Loading pipeline…")).toHaveCount(0);
  } finally {
    openGate();
  }
});

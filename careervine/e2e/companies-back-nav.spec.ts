/**
 * Flow 11 (CAR-256): returning to /companies from a company gives back the list
 * you left — same filters, same rows, same place on the page — without going to
 * the network for any of it.
 *
 * ── What this proves ──────────────────────────────────────────────────────
 *
 * Three properties of the round trip, each with a measurement behind it rather
 * than a state comparison a slow write could win by default:
 *
 *  1. THE FILTERS SURVIVE. The URL still carries `?status=applied` and the chip
 *     still reads pressed. Cheap, and it is the half of the ticket the URL
 *     already handled before CAR-256; it is here as a regression guard, not as
 *     the interesting claim.
 *  2. NOTHING IS REFETCHED. Measured at ZERO counted data requests across the
 *     whole return, against 18 for the same page's cold load. Counted with
 *     `helpers/request-budget.ts`, the same machinery the per-route budgets use,
 *     so "the list came from `list-cache.ts`" is an observation about the wire
 *     rather than an inference from how fast the rows appeared.
 *  3. THE SCROLL POSITION SURVIVES, to the pixel.
 *
 * Both ways back are covered, because they are different mechanisms that happen
 * to converge on one history entry: the browser's own Back, and the company
 * page's "Back" button, which calls `router.back()` only when
 * `hasInAppBackHistory()` says this tab arrived from inside the app.
 *
 * ── What this does NOT prove, measured rather than assumed ────────────────
 *
 * THE FIRST TWO TESTS DO NOT PROVE THAT `use-scroll-restoration.ts` PERFORMS
 * THE RESTORE, and they cannot. `window.scrollTo` was wrapped in a run of this
 * flow: the hook never calls it. `history.scrollRestoration` is `auto` here, so
 * Chrome puts the offset back itself ~14ms after `popstate`, the hook finds
 * `window.scrollY > 0`, and it deliberately declines to fight the browser. What
 * carries assertion 3 in those two tests is therefore the CACHE: Chrome's
 * restore is clamped to the document height at the moment it runs, and it
 * succeeds only because the cached list is already at full height on the painted
 * commit (3,446px, 14ms after the pop). Falsified the other way too — making
 * `readList` always miss drops the scroll from 2,006px to 0 and takes the
 * zero-request assertion down with it.
 *
 * That is what the fourth test is for. It turns `history.scrollRestoration` to
 * `manual`, which removes the browser from the equation and leaves the hook as
 * the only thing that can put the page back. That is the fallback that matters
 * on a slower machine or a longer list, where React's commit can lose the race
 * to Chrome's restore and the browser clamps to 0 exactly as it did before
 * CAR-256.
 *
 * A DEFECT THIS FILE FOUND, now fixed, worth keeping written down because the
 * shape recurs: the first version of the hook recorded every scroll event
 * unconditionally, and navigating to a company makes Next scroll the OUTGOING
 * list back to the top while it is still mounted. The listener dutifully
 * recorded that 0 over the real offset, so `recallScroll` could never return a
 * usable value and the whole sessionStorage half was inert. The hook now ignores
 * a scroll whose live `location.pathname` is no longer the view being recorded.
 * The fourth test asserts the remembered offset survives that navigation, which
 * is the assertion that would have caught it.
 *
 * It also proves nothing about a HARD reload of /companies. The cache is module
 * scope and dies with the document, which is deliberate (see
 * `src/lib/list-cache.ts`), so every measurement below is a client-side
 * transition and none of them is a page refresh.
 *
 * ── Why this file mints its own tenant ────────────────────────────────────
 *
 * The same documented exception `request-budget.spec.ts` takes, for the same
 * reason: it needs VOLUME the shared single-worker tenant must not carry. A
 * scroll-restoration assertion is meaningless on a page that fits in the
 * viewport, and the shared tenant's one-row-per-table scale cannot fill one. It
 * also seeds the shared `companies` catalog, which does not cascade on tenant
 * delete, so `afterAll` removes those rows itself.
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
import { formatTally, measurePageLoad, tallyRequests } from "./helpers/request-budget";
import { MIN_REFRESH_INTERVAL_MS } from "@/lib/list-cache";
import type { Database } from "@/lib/database.types";

type TableName = keyof Database["public"]["Tables"] & string;
type Insertable<T extends TableName> = Database["public"]["Tables"][T]["Insert"];

// Signed out at the project level: this file mints its own session per test
// rather than inheriting the shared one.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Companies seeded, and how many of them are `applied`.
 *
 * 30 is chosen for HEIGHT, not for volume: 24 cards render ~3,400px against a
 * 720px viewport, so the card this flow scrolls to sits ~2,000px down and a
 * failed restore cannot hide inside a short page. The 6 that are not `applied`
 * are what make the status chip a real filter — with every company applied it
 * would be a no-op and "the filters survived" would be unfalsifiable.
 */
const SEED = 30;
const APPLIED = 24;
const NAME_PREFIX = "Revisit Co";
/**
 * A company card's accessible name is the whole card (initial, name, chips,
 * counts), so it is matched on the seeded prefix rather than compared. The
 * prefix deliberately avoids the word "Back": `getByRole` name matching is
 * substring by default, and an earlier "Backnav Co 04" collided with the
 * company page's "Back" button.
 */
const CARD_NAME = new RegExp(`${NAME_PREFIX} \\d`);
/** Deep enough into the list that reaching it is a real scroll. */
const CARD_INDEX = 15;

let tenant: Tenant;
/** Shared-catalog rows this file owns and must remove itself — see afterAll. */
let seededCompanyIds: number[] = [];

test.beforeAll(async () => {
  tenant = await createTenant("e2e-backnav");
  const svc = serviceClient();
  // Premium and past onboarding, so nothing renders a full-screen step over the
  // list (see `completeOnboarding`).
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

  // The list is `getCompanies(scope: "in_play", minContacts: 1)`, so a company
  // needs a CURRENT non-bench contact to appear at all. One contact each.
  const contactIds = await idsOf(
    "contacts",
    Array.from({ length: SEED }, (_, i) => ({
      user_id: tenant.userId,
      name: `Revisit Contact ${String(i).padStart(2, "0")}`,
      network_status: "active",
      headline: "Product Manager",
    })),
  );
  await insert(
    "contact_emails",
    contactIds.map((id, i) => ({
      contact_id: id,
      email: `${uniq(`revisit-${i}`)}@example.com`,
      is_primary: true,
    })),
  );

  const companyIds = await idsOf(
    "companies",
    Array.from({ length: SEED }, (_, i) => ({
      name: uniq(`${NAME_PREFIX} ${String(i).padStart(2, "0")}`),
    })),
  );
  seededCompanyIds = companyIds;
  await insert(
    "contact_companies",
    companyIds.map((companyId, i) => ({
      contact_id: contactIds[i],
      company_id: companyId,
      is_current: true,
      title: "Product Manager",
    })),
  );
  await insert(
    "target_companies",
    companyIds.map((companyId, i) => ({
      user_id: tenant.userId,
      company_id: companyId,
      is_targeted: true,
      status: i < APPLIED ? "applied" : "researching",
    })),
  );
});

test.afterAll(async () => {
  // The teardown project also sweeps `itest-e2e-*`, so a crash before here still
  // converges; this keeps the stack clean within the run.
  if (tenant?.userId) await deleteTenant(tenant.userId);

  // `companies` is the SHARED catalog: deleting the tenant cascades the
  // user-owned rows that point at these (contact_companies, target_companies)
  // but never the companies themselves, and nothing else sweeps them. Ordered
  // after deleteTenant so the FK dependents are already gone.
  if (seededCompanyIds.length > 0) {
    await serviceClient().from("companies").delete().in("id", seededCompanyIds);
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto(await mintSessionUrl(tenant.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

const companyCards = (page: Page) => page.getByRole("link", { name: CARD_NAME });
const appliedChip = (page: Page) => page.getByRole("button", { name: /^Applied\b/ });
const backButton = (page: Page) => page.getByRole("button", { name: "Back", exact: true });

/**
 * Load /companies from scratch and tally what that costs.
 *
 * `measurePageLoad` parks on `about:blank` first, which also drops the
 * in-memory list cache — this is the COLD number the return is compared
 * against, so it has to start from a document that has never held the list.
 */
async function openListCold(page: Page): Promise<number> {
  const tally = await measurePageLoad(page, "/companies");
  await expect(page.getByRole("heading", { name: "Companies", level: 1 })).toBeVisible();
  await expect(companyCards(page).first()).toBeVisible();
  expect(
    tally.total,
    `a cold /companies load must actually read data, or the zero-request assertion below is ` +
      `measuring a page that never fetches anything:\n${formatTally(tally.byEndpoint)}`,
  ).toBeGreaterThan(5);
  return tally.total;
}

/** Click the Applied stage chip and wait for the URL and the list to follow. */
async function applyAppliedFilter(page: Page): Promise<void> {
  await appliedChip(page).click();
  await expect(page).toHaveURL(/[?&]status=applied\b/);
  // The result line renders only while a filter is active, so its presence is
  // also the proof that the chip did something.
  await expect(page.getByText(`${APPLIED} of ${SEED} companies`)).toBeVisible();
}

/**
 * Scroll the Nth company card into view and hand it back with the offset that
 * produced.
 *
 * `scrollIntoViewIfNeeded` rather than `window.scrollTo`, and this is
 * load-bearing. Playwright runs the same scroller before a click, so
 * positioning the card with it leaves the click nothing left to do. Done the
 * other way round — scroll to a fixed offset, then click a card measured to be
 * fully inside the viewport — the click still moved the page first (900px to
 * 338px, reproducibly), and every scroll assertion afterwards was comparing
 * against a position the user never actually left from.
 */
async function scrollToCard(page: Page, index: number): Promise<{ card: Locator; scrollY: number }> {
  const card = companyCards(page).nth(index);
  await card.scrollIntoViewIfNeeded();
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(
    scrollY,
    `card ${index} must be far enough down the list that reaching it is a real scroll`,
  ).toBeGreaterThan(300);
  return { card, scrollY };
}

/** The position `scroll-memory.ts` has committed for one filtered view, or 0. */
function readRememberedScroll(page: Page, search: string): Promise<number> {
  return page.evaluate((s) => {
    const raw = sessionStorage.getItem("cv:scroll:/companies");
    if (!raw) return 0;
    const entry = (JSON.parse(raw) as [string, number][]).find(([k]) => k === s);
    return entry ? entry[1] : 0;
  }, search);
}

/**
 * Wait until the scroll listener has committed a non-zero position for this
 * view, and return it.
 *
 * Not an arbitrary wait: `use-scroll-restoration.ts` writes on a
 * requestAnimationFrame after a real scroll event, so this polls exactly the
 * state the next navigation will read.
 */
async function rememberedScrollFor(page: Page, search: string): Promise<number> {
  await expect
    .poll(() => readRememberedScroll(page, search), {
      message: `no scroll position was remembered for "/companies?${search}"`,
    })
    .toBeGreaterThan(0);
  return readRememberedScroll(page, search);
}

/**
 * Wait for whatever is on screen to stop requesting data.
 *
 * Synchronised to browser traffic rather than a sleep: `tallyRequests` returns
 * as soon as nothing new has been requested for its quiet window.
 */
async function settle(page: Page, label: string): Promise<void> {
  await tallyRequests(page, async () => {}, { label });
}

const RETURN_PATHS = {
  "browser back": (page: Page) => page.goBack(),
  // `router.back()` behind `hasInAppBackHistory()` — a different mechanism
  // reaching the same history entry, which is why both are measured rather than
  // one standing in for the other.
  "the in-app Back button": (page: Page) => backButton(page).click(),
} as const;

for (const [label, goBack] of Object.entries(RETURN_PATHS)) {
  test(`${label} returns to the companies list unchanged`, async ({ page }) => {
    const coldRequests = await openListCold(page);
    await applyAppliedFilter(page);

    const { card, scrollY } = await scrollToCard(page, CARD_INDEX);
    expect(
      await rememberedScrollFor(page, "status=applied"),
      "the remembered position must be the one the user is actually looking at",
    ).toBe(scrollY);

    await card.click();
    await expect(page).toHaveURL(/\/companies\/\d+/);
    await expect(backButton(page)).toBeVisible();
    // The company page's own reads have to finish BEFORE the measured window
    // opens, or they land inside it and the return looks like it refetched.
    await settle(page, "the company page");

    const tally = await tallyRequests(
      page,
      async () => {
        await goBack(page);
        await expect(page).toHaveURL(/\/companies\?/);
        await expect(companyCards(page).first()).toBeVisible();
      },
      { label: `returning to /companies via ${label}` },
    );

    // ── 1. The filters survived ─────────────────────────────────────────
    await expect(page).toHaveURL(/[?&]status=applied\b/);
    await expect(
      appliedChip(page),
      "the stage chip must still read pressed, not just the URL",
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(`${APPLIED} of ${SEED} companies`)).toBeVisible();

    // ── 2. Nothing was refetched ────────────────────────────────────────
    // Measured at 0, against a cold load of 18. Zero rather than a ceiling
    // because there is no request this return is entitled to make: the list is
    // served from `list-cache.ts`, and every other component on the page was
    // already mounted before the trip. If a shell read legitimately moves onto
    // this path, raise this deliberately and name it — do not widen it enough to
    // absorb an accidental refetch of the list itself.
    expect(
      tally.total,
      `returning to /companies made ${tally.total} data request(s); a cold load of the same ` +
        `page made ${coldRequests}. The return must serve the list from the in-memory cache ` +
        `(src/lib/list-cache.ts) and read nothing.\n${formatTally(tally.byEndpoint)}`,
    ).toBe(0);

    // ── 3. The scroll position survived ─────────────────────────────────
    // Exact, not approximate: the offset is put back by the browser's own
    // restoration against a document the cache has already brought to full
    // height, and neither step rounds. A tolerance would let a PARTIAL restore
    // pass, which is the exact shape of the failure this guards — a clamped
    // restore landing at 338px of a 2,006px offset.
    expect(
      await page.evaluate(() => window.scrollY),
      `the list must come back at ${scrollY}px, where it was left`,
    ).toBe(scrollY);
  });
}

test("arriving from the nav bar starts at the top", async ({ page }) => {
  // The guard on assertion 3: a remembered position may only be applied to a
  // back/forward navigation. Clicking "Companies" in the nav bar is a request to
  // go to the page, and landing mid-list there is disorienting.
  //
  // This does discriminate `consumePopNavigation`'s pop gate, but only because
  // the remembered offset now survives the trip (see the header's note on the
  // defect that used to leave it at 0). The assertion below is a real one: there
  // is a stored position for this exact view at the moment of the landing, and
  // the gate is the only reason it is not applied.
  await openListCold(page);
  const { card } = await scrollToCard(page, CARD_INDEX);
  const remembered = await rememberedScrollFor(page, "");

  await card.click();
  await expect(page).toHaveURL(/\/companies\/\d+/);
  await settle(page, "the company page");

  await page.getByRole("link", { name: "Companies" }).first().click();
  await expect(page).toHaveURL(/\/companies$/);
  await expect(companyCards(page).first()).toBeVisible();

  expect(
    await page.evaluate(() => window.scrollY),
    `a forward navigation must land at the top; ${remembered}px was where this view was left`,
  ).toBe(0);
});

test("restores the position itself when the browser's own restoration is off", async ({ page }) => {
  // The discriminating test for `use-scroll-restoration.ts`. With
  // `history.scrollRestoration` at its default `auto`, Chrome restores the
  // offset before the hook would and the hook stands down, so the two tests
  // above pass whether it works or not. Turning restoration off leaves the hook
  // as the only mechanism that can put the page back.
  await page.addInitScript(() => {
    history.scrollRestoration = "manual";
  });

  await openListCold(page);
  await applyAppliedFilter(page);
  const { card, scrollY } = await scrollToCard(page, CARD_INDEX);
  await rememberedScrollFor(page, "status=applied");

  await card.click();
  await expect(page).toHaveURL(/\/companies\/\d+/);
  await settle(page, "the company page");

  // The offset has to SURVIVE the navigation, which is the half that used to be
  // broken: Next scrolls the outgoing list to the top while it is still
  // mounted, and an unguarded listener records that 0 over the real value.
  expect(
    await readRememberedScroll(page, "status=applied"),
    "the remembered offset must survive the scroll-to-top Next performs on the outgoing page",
  ).toBe(scrollY);

  await backButton(page).click();
  await expect(page).toHaveURL(/[?&]status=applied\b/);
  await expect(companyCards(page).first()).toBeVisible();

  // Polled: the hook restores from a layout effect on the commit that hydrates
  // from cache, which is a commit later than the URL change Playwright saw.
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: "with the browser's restoration off, the hook must put the list back itself",
    })
    .toBe(scrollY);
});

/**
 * CAR-278. Everything above measures a return that nothing WROTE to. The write
 * path was the hole: `refreshCompaniesList` used to only delete, so the moment
 * the user was most likely to press Back was the one moment the cache was
 * guaranteed to miss, and the return paid for a full `getCompanies` aggregate.
 *
 * Two claims, and the second needs the offset deliberately blinded to be worth
 * anything. A background refresh can REORDER the list, which is what the anchor
 * exists for, but on this seeded tenant the write does not happen to move the
 * row — so a plain "the row is on screen" assertion would pass on the offset
 * alone and prove nothing about the anchor. Rewriting the stored offset to 0
 * reproduces exactly the state a reorder leaves behind (a position that still
 * restores, but no longer points at the row) without depending on a reordering
 * that is not under this test's control.
 *
 * Falsification, both run: reverting `refreshCompaniesList` to a plain delete
 * takes the request count from 0 to 18, and dropping the anchor block from
 * `use-scroll-restoration.ts` leaves the card off screen.
 */
test("a write keeps the list warm, and the return lands on the row you left", async ({ page }) => {
  // Chrome's own restoration would put the page back from ITS memory, which the
  // blinding below cannot reach, and the anchor would have nothing to rescue.
  await page.addInitScript(() => {
    history.scrollRestoration = "manual";
  });

  await openListCold(page);
  const { card } = await scrollToCard(page, CARD_INDEX);
  const anchor = await card.getAttribute("data-scroll-anchor");
  expect(anchor, "the card must carry the anchor the return trip looks for").toBeTruthy();
  await rememberedScrollFor(page, "");

  await card.click();
  await expect(page).toHaveURL(/\/companies\/\d+/);
  await expect(backButton(page)).toBeVisible();
  await settle(page, "the company page");

  // A real write through `usePipelineAutosave`, which is the busiest caller of
  // `refreshCompaniesList` and the one that made the delete-only version hurt.
  await page.getByRole("button", { name: "Company status" }).click();
  await page.getByRole("option", { name: "Not a target" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Quiet for longer than the refresh throttle, so a TRAILING run cannot still
  // be pending when the measured window opens and score as a refetch.
  await tallyRequests(page, async () => {}, {
    quietMs: MIN_REFRESH_INTERVAL_MS + 2_000,
    label: "the write and the background refresh it starts",
  });

  // Blind the offset — see the header. The anchor is left untouched.
  await page.evaluate(() => {
    const raw = sessionStorage.getItem("cv:scroll:/companies");
    if (!raw) throw new Error("no scroll memory to blind; the recording half is broken");
    const list = JSON.parse(raw) as [string, number, string?][];
    sessionStorage.setItem(
      "cv:scroll:/companies",
      JSON.stringify(list.map((e) => (e[0] === "" ? [e[0], 0, e[2]] : e))),
    );
  });

  const tally = await tallyRequests(
    page,
    async () => {
      await backButton(page).click();
      await expect(page).toHaveURL(/\/companies$/);
      await expect(companyCards(page).first()).toBeVisible();
    },
    { label: "returning to /companies after a write" },
  );

  // ── 1. The write left the list WARM ─────────────────────────────────
  expect(
    tally.total,
    `returning after a write made ${tally.total} data request(s). The write is supposed to ` +
      `refetch the list in the background while the user is still on the company page, so the ` +
      `return finds it cached (src/lib/companies-list-cache.ts).\n${formatTally(tally.byEndpoint)}`,
  ).toBe(0);

  // ── 2. The return landed on the row ─────────────────────────────────
  await expect(
    page.locator(`[data-scroll-anchor="${anchor}"]`),
    "with the offset no longer pointing at it, only the remembered anchor can bring the row " +
      "the user left through back on screen",
  ).toBeInViewport();
});

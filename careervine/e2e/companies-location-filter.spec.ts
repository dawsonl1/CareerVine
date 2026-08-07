/**
 * Companies location filter (CAR-251): the filter scopes the CARD, not just the row set.
 *
 * Why this needs a browser rather than another unit test. `company-location-filter.ts`
 * is pure and already pinned hard by `src/__tests__/company-location-filter.test.ts`,
 * including the double-count and unknown-remainder rules. What no unit test can show
 * is that the selection actually reaches the card: the filter is parsed in
 * `app/companies/page.tsx`, memoized, threaded through `CompanyCard`'s
 * `locationSelection` prop, and only then does `scopedCounts` run. Any break in that
 * chain leaves every pure test green while the page renders unscoped counts.
 *
 * The three assertions map to the three product decisions on CAR-251:
 *   1. a company matches on its OFFICE REGISTRY, not on who works there;
 *   2. the card reports the selected office and NAMES the remainder it cannot see,
 *      because only ~half of real employment rows carry a location and a bare scoped
 *      count is indistinguishable from a company with one employee;
 *   3. click-through pre-selects an office only when the selection is unambiguous FOR
 *      THAT COMPANY — which is why the two-city case below asserts opposite hrefs on
 *      two cards under the SAME filter, the one shape a single-company test cannot show.
 *
 * Seeds and removes its own rows (the shared tenant is single-worker and file-ordered,
 * so a spec that mutates it puts it back in afterEach, never `finally` — a body
 * abandoned at the test timeout never reaches a `finally`).
 */
import { test, expect } from "./fixtures/test";
import { serviceClient, uniq } from "./helpers/tenant";
import fs from "node:fs";
import type { Database } from "@/lib/database.types";
import { TENANT_FILE } from "./helpers/tenant";

const svc = serviceClient();

/** Ids created here, torn down in afterEach. */
let created: {
  companyIds: number[];
  contactIds: number[];
  locationIds: number[];
  lehi: number;
  boston: number;
  multiCo: number;
  bostonCo: number;
  noOfficeCo: number;
  cityLabels: { lehi: string; boston: string };
} | null = null;

/**
 * Typed the way the integration tier's own seeder is (`tenant-graph.ts:66`):
 * the table name is narrowed to the generated union so a typo is a compile
 * error, and only the payload takes the `as never` the supabase-js insert
 * overload needs.
 */
type SeedTable = keyof Database["public"]["Tables"];

async function insert(table: SeedTable, row: Record<string, unknown>): Promise<{ id: number }> {
  const { data, error } = await svc.from(table).insert(row as never).select("id").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data as unknown as { id: number };
}

test.beforeEach(async () => {
  const { userId } = JSON.parse(fs.readFileSync(TENANT_FILE, "utf8")) as { userId: string };

  const lehiCity = uniq("Lehi");
  const bostonCity = uniq("Boston");
  const lehi = await insert("locations", { city: lehiCity, state: "Utah", country: "United States" });
  const boston = await insert("locations", { city: bostonCity, state: "Massachusetts", country: "United States" });

  // Two offices; the filter matches on these regardless of who works where.
  const multiCo = await insert("companies", { name: uniq("E2E Multi Office Co") });
  const bostonCo = await insert("companies", { name: uniq("E2E Boston Only Co") });
  // No company_locations row at all: the "No location set" option exists so this
  // company stays reachable rather than vanishing once any location is picked.
  const noOfficeCo = await insert("companies", { name: uniq("E2E No Office Co") });
  await insert("company_locations", { company_id: multiCo.id, location_id: lehi.id, source: "manual" });
  await insert("company_locations", { company_id: multiCo.id, location_id: boston.id, source: "manual" });
  await insert("company_locations", { company_id: bostonCo.id, location_id: boston.id, source: "manual" });

  // multiCo: one person in each office, plus one whose office was never recorded.
  // That third contact is the whole point of the "location unknown" assertion.
  const atLehi = await insert("contacts", { user_id: userId, name: uniq("Lehi Person"), network_status: "active" });
  const atBoston = await insert("contacts", { user_id: userId, name: uniq("Boston Person"), network_status: "active" });
  const unplaced = await insert("contacts", { user_id: userId, name: uniq("Unplaced Person"), network_status: "active" });
  const atBostonCo = await insert("contacts", { user_id: userId, name: uniq("Boston Co Person"), network_status: "active" });
  const atNoOffice = await insert("contacts", { user_id: userId, name: uniq("No Office Person"), network_status: "active" });

  await insert("contact_companies", { contact_id: atLehi.id, company_id: multiCo.id, is_current: true, location_id: lehi.id });
  await insert("contact_companies", { contact_id: atBoston.id, company_id: multiCo.id, is_current: true, location_id: boston.id });
  await insert("contact_companies", { contact_id: unplaced.id, company_id: multiCo.id, is_current: true, location_id: null });
  await insert("contact_companies", { contact_id: atBostonCo.id, company_id: bostonCo.id, is_current: true, location_id: boston.id });
  await insert("contact_companies", { contact_id: atNoOffice.id, company_id: noOfficeCo.id, is_current: true, location_id: null });

  created = {
    companyIds: [multiCo.id, bostonCo.id, noOfficeCo.id],
    contactIds: [atLehi.id, atBoston.id, unplaced.id, atBostonCo.id, atNoOffice.id],
    locationIds: [lehi.id, boston.id],
    lehi: lehi.id,
    boston: boston.id,
    multiCo: multiCo.id,
    bostonCo: bostonCo.id,
    noOfficeCo: noOfficeCo.id,
    cityLabels: { lehi: `${lehiCity}, Utah`, boston: `${bostonCity}, Massachusetts` },
  };
});

test.afterEach(async () => {
  if (!created) return;
  // contact_companies and company_locations cascade from their parents.
  await svc.from("contacts").delete().in("id", created.contactIds);
  await svc.from("companies").delete().in("id", created.companyIds);
  await svc.from("locations").delete().in("id", created.locationIds);
  created = null;
});

test("a city filter scopes the card and pre-selects that office on click", async ({ page }) => {
  const c = created!;
  await page.goto(`/companies?loc=c:${c.lehi}`);

  const multi = page.locator(`a[href^="/companies/${c.multiCo}"]`);
  await expect(multi).toBeVisible();

  // Matched on the office registry: this company has a Lehi office. The
  // Boston-only company does not, and neither does the office-less one, so both
  // are gone.
  await expect(page.locator(`a[href^="/companies/${c.bostonCo}"]`)).toHaveCount(0);
  await expect(page.locator(`a[href^="/companies/${c.noOfficeCo}"]`)).toHaveCount(0);

  // Scoped headcount names the office, and the unrecorded contact is DECLARED
  // rather than silently dropped. Without the remainder line this card would
  // read "1 person" at a company where three people work.
  await expect(multi).toContainText(`1 person in ${c.cityLabels.lehi}`);
  await expect(multi).toContainText("1 contact location unknown");

  // Unambiguous for this company, so the card opens straight to the office.
  await expect(multi).toHaveAttribute("href", `/companies/${c.multiCo}?location=${c.lehi}`);
});

test("two cities: the card the filter is ambiguous for opens company-wide, the other still pre-selects", async ({ page }) => {
  const c = created!;
  await page.goto(`/companies?loc=c:${c.lehi}&loc=c:${c.boston}`);

  const multi = page.locator(`a[href^="/companies/${c.multiCo}"]`);
  const bostonOnly = page.locator(`a[href^="/companies/${c.bostonCo}"]`);
  await expect(multi).toBeVisible();
  await expect(bostonOnly).toBeVisible();

  // Both offices matched, so the counts are a union and landing on one of them
  // would show a different number than the one just clicked.
  await expect(multi).toHaveAttribute("href", `/companies/${c.multiCo}`);
  // Same filter, but only ONE of this company's offices is in it, so it still
  // pre-selects. This is the pair that proves the rule is per-company
  // ambiguity rather than "how many cities are selected".
  await expect(bostonOnly).toHaveAttribute("href", `/companies/${c.bostonCo}?location=${c.boston}`);

  // Union, not sum: the two located contacts plus the unplaced one.
  await expect(multi).toContainText("2 people");
  await expect(multi).toContainText("1 contact location unknown");
});

test("the location dropdown renders states as groups with their cities nested", async ({ page }) => {
  const c = created!;
  await page.goto("/companies");

  // The secondary facets live behind the Filters drawer.
  await page.getByRole("button", { name: /filters/i }).click();
  const trigger = page.getByRole("combobox", { name: "Filter by location" });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const listbox = page.getByRole("listbox", { name: "Filter by location" });
  await expect(listbox.getByRole("option", { name: /^Utah/ })).toBeVisible();
  await expect(listbox.getByRole("option", { name: new RegExp(`^${c.cityLabels.lehi}`) })).toBeVisible();
  await expect(listbox.getByRole("option", { name: "No location set", exact: false })).toBeVisible();

  // Clicking the STATE selects it, and the trigger names the group rather than a city.
  await listbox.getByRole("option", { name: /^Utah/ }).click();
  await expect(trigger).toContainText("Utah");
  await expect(page).toHaveURL(/loc=s%3AUtah|loc=s:Utah/);
});

test("`No location set` reaches the companies a city filter would hide", async ({ page }) => {
  const c = created!;
  await page.goto("/companies?loc=none");

  // The escape hatch: without this option, a company whose office was never
  // recorded becomes unreachable the moment the user touches the filter.
  await expect(page.locator(`a[href^="/companies/${c.noOfficeCo}"]`)).toBeVisible();
  await expect(page.locator(`a[href^="/companies/${c.multiCo}"]`)).toHaveCount(0);

  // It matches no office, so there is nothing to pre-select.
  await expect(page.locator(`a[href^="/companies/${c.noOfficeCo}"]`)).toHaveAttribute(
    "href",
    `/companies/${c.noOfficeCo}`,
  );
});

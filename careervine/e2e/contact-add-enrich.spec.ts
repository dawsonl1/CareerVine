/**
 * Flow 4 (CAR-191): add a contact by hand, then import one from LinkedIn, and
 * prove `linkedin_url` CANONICALIZATION happened both times.
 *
 * Why canonicalization is the assertion rather than "a contact appeared":
 * the contacts table dedupes on exact `linkedin_url` string equality, so every
 * write must land on `https://www.linkedin.com/in/<slug>` or the same person
 * silently becomes two rows. CAR-155 moved that guarantee into the write
 * chokepoint (`canonicalizeContactPayload` in `src/lib/data/contacts.ts:252`),
 * and the unit tier pins the pure function — but nothing proved the chokepoint
 * is actually on the path a *user* takes. Both surfaces below reach it through
 * genuinely different code:
 *
 *   - the manual form calls `createContact` from the BROWSER (via
 *     `src/lib/queries.ts`, which re-exports the chokepoint), so the transform
 *     runs client-side against the user's own RLS session;
 *   - the import posts `/api/contacts/import`, which reaches the SAME
 *     chokepoint server-side after its own dedupe probe.
 *
 * Note the two are not equally load-bearing, and the difference was measured
 * rather than assumed. Stubbing the chokepoint's transform to a no-op turns the
 * manual-add test RED and leaves the import test GREEN, because
 * `/api/contacts/import` canonicalizes on its own before it ever reaches the
 * chokepoint (it has to — the dedupe probe runs first). So the import test is an
 * end-to-end OUTCOME check on a path with two independent guarantees, not a
 * second probe of the chokepoint. Both are worth having; only the first would
 * catch a regression in `canonicalizeContactPayload` itself.
 *
 * The messy input is chosen so the DB safety net cannot produce a false pass.
 * The `contacts_tidy_linkedin_url` trigger (migration 20260719120000)
 * deliberately implements only the cheap half — trim, strip trailing slashes,
 * empty to NULL — precisely to avoid a second rule implementation that could
 * drift. Uppercase host, uppercase slug, and the `?trk=` query string are
 * app-only transforms, so an assertion that they were normalized is an
 * assertion the application chokepoint ran, not the trigger.
 */
import { test, expect } from "./fixtures/test";
import { serviceClient, uniq } from "./helpers/tenant";
import { encodeProfileData } from "@/lib/profile-encoding";
import type { ProfileData } from "@/lib/extension-contract";

/** The canonical form every variant below must collapse to. */
function canonicalUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

async function contactsWithUrl(url: string): Promise<{ id: number; name: string | null }[]> {
  const { data, error } = await serviceClient()
    .from("contacts")
    .select("id, name")
    .eq("linkedin_url", url);
  if (error) throw new Error(`contactsWithUrl(${url}): ${error.message}`);
  return data ?? [];
}

test("adding a contact by hand canonicalizes its LinkedIn URL on write", async ({ page }) => {
  // Lowercase slug + mixed-case as typed, so the expected value is unambiguous.
  const slug = uniq("e2e-ada");
  const name = uniq("E2E Ada");
  // Uppercase scheme and host, a capitalised slug, a trailing slash, and a
  // tracking query string: four transforms, only ONE of which the DB trigger
  // could account for.
  const typed = `HTTP://WWW.LinkedIn.com/in/${slug.toUpperCase()}/?trk=e2e-flow-4`;

  await test.step("fill and submit the new-contact form", async () => {
    await page.goto("/contacts");
    await page.getByRole("button", { name: "Add contact" }).click();

    // The form's labels are not associated with their inputs (no htmlFor/id
    // pairing), so `getByLabel` finds nothing here. Placeholders are the stable
    // accessible handle this form actually offers, and the signup spec already
    // selects the same way — adding a `data-testid` for a field that is already
    // uniquely addressable would be the exact testid sprawl CONVENTIONS §i
    // warns against.
    await expect(page.getByRole("heading", { name: "New contact" })).toBeVisible();
    await page.getByPlaceholder("Full name").fill(name);
    await page.getByPlaceholder("https://linkedin.com/in/...").fill(typed);
    await page.getByRole("button", { name: "Create", exact: true }).click();
  });

  await test.step("the contact appears in the list", async () => {
    await expect(page.getByRole("heading", { name: "New contact" })).toBeHidden();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  });

  await test.step("the stored URL is canonical, not what was typed", async () => {
    // Read the row by NAME, so the query cannot presuppose the answer: looking
    // it up by the canonical URL would return nothing and read as "no contact"
    // rather than "wrong URL" if canonicalization had been skipped.
    const { data, error } = await serviceClient()
      .from("contacts")
      .select("id, linkedin_url")
      .eq("name", name)
      .single();
    if (error) throw new Error(`created contact not found by name: ${error.message}`);

    expect(data.linkedin_url).toBe(canonicalUrl(slug));
    expect(data.linkedin_url).not.toBe(typed);
  });
});

test("importing a LinkedIn profile canonicalizes it, and a re-import dedupes", async ({ page }) => {
  const slug = uniq("e2e-grace");
  const name = uniq("E2E Grace");

  /**
   * The payload the Chrome extension hands to the preview page.
   *
   * `photo_url` is deliberately absent: the import route downloads it, and the
   * only origin that could serve one here is external — which the stub layer
   * correctly denies. Omitting it keeps this flow's failure modes to the one
   * under test rather than adding a handler for an asset nothing asserts on.
   */
  const profile: ProfileData = {
    name,
    // Messy on purpose, exactly as a scraped profile URL arrives. An
    // already-canonical value here would make the assertion below a tautology:
    // measured during authoring, the import test stayed GREEN with the
    // chokepoint's transform stubbed out, because a no-op transform on an
    // already-canonical string is indistinguishable from a working one.
    linkedin_url: `HTTPS://WWW.LinkedIn.com/in/${slug.toUpperCase()}/?utm_source=e2e`,
    headline: "E2E import subject",
    location: {},
    experience: [],
    education: [],
    suggested_tags: [],
    contact_status: null,
  };

  let contactId: number | undefined;

  await test.step("import through the extension preview surface", async () => {
    // The real hand-off: the extension encodes the profile into the URL hash
    // and opens this page. `encodeProfileData` is the app's own encoder, so the
    // test cannot drift from the format the page decodes.
    await page.goto(`/contacts/preview#data=${encodeProfileData({ ...profile })}`);

    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Save/ }).click();

    // The page redirects to the saved contact after a deliberate 1.5s pause.
    // Asserting on the URL rides Playwright's own retry budget instead of
    // sleeping for it.
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
    contactId = Number(new URL(page.url()).pathname.split("/").pop());
    expect(Number.isInteger(contactId)).toBe(true);
  });

  await test.step("the imported row carries the canonical URL", async () => {
    const rows = await contactsWithUrl(canonicalUrl(slug));
    expect(rows.map((r) => r.id)).toEqual([contactId]);
  });

  await test.step("a differently-formatted URL for the same profile resolves to the same contact", async () => {
    // No www, uppercase slug, trailing slash: a genuinely different string that
    // must not create a second row. The preview page probes
    // /api/contacts/check-duplicate on load, which canonicalizes before
    // comparing — so the redirect below IS the dedupe, observed end to end.
    const variant: ProfileData = {
      ...profile,
      linkedin_url: `https://linkedin.com/in/${slug.toUpperCase()}/`,
    };
    await page.goto(`/contacts/preview#data=${encodeProfileData({ ...variant })}`);

    await expect(page).toHaveURL(new RegExp(`/contacts/${contactId}$`));
  });

  await test.step("and there is still exactly one contact for that profile", async () => {
    const rows = await contactsWithUrl(canonicalUrl(slug));
    expect(
      rows,
      "a formatting variant of an already-imported LinkedIn URL created a duplicate contact",
    ).toHaveLength(1);
  });
});

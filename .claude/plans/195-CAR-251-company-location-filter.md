# CAR-251 — Replace the bundle-only tier filter with a location filter, and make it scope the company card

## Why

`target_companies.tier` is free text written by exactly one path: `POST /api/target-companies/bulk-import`, an external ops script that loaded one APM target sheet. No UI sets it, the data bundle does not set it, and `company-filter-bar.tsx` hides the dropdown entirely below two distinct values, so for every user but one the filter does not exist. It also conflates a segment (`Big Tech`) with geography (`Boston`, `SF Bay Area`).

A universal location model already exists and is populated (`locations` + `company_locations`, 6,184 rows covering 4,564 of 7,570 companies) and nothing in the app filters on it.

Full problem statement, production tier/location tables, and the eight product decisions live on the Linear issue and are not restated here.

## Design decisions taken during planning

**No RPC change is needed.** The ticket assumed `company_network_counts` would need a location-keyed variant. It does not. `getCompanies` already fetches every employment row for exactly the displayed companies via `fetchEmploymentRowsForCompanies(userId, companyIds)` (company-queries.ts:861), gated on `runEnrichment = enrich && scope !== "all"`, and the companies page calls `getCompanies(user.id, { scope: "in_play", ... })` with `enrich` defaulting to `true` (line 735). So on the only page that will ever hold a location filter, the client already holds a complete per-person tally. Adding `location_id, workplace_type` to that one existing `.select()` (line 684) yields exact, set-based, per-location counts for all eight card fields with **zero new queries and zero SQL**.

Consequences that must hold:
- The RPC stays authoritative for **unscoped** counts, preserving today's behavior and the `enrich: false` / `scope: "all"` paths where `employment` is `[]`.
- Location-scoped counts are computed client-side and rendered **only** while a location filter is active. The two are never mixed within one card.
- An integration test asserts the client-side unscoped rollup equals the RPC's counts, so the two definitions cannot drift silently.
- Scoping must replicate the RPC's `per_pair` collapse (one row per contact, current beating former) but keyed per `(company, location, contact)`, matching `personInFacet` in `company-scopes.ts`.

**`company_locations` is a global table, not user-scoped.** Rows written by the migrations below are visible to every user. That is deliberate and correct: an office is an objective fact about a company, not personal data. It does mean the anchor mapping asserts facts globally, which is why provenance gets its own source values.

**Both migrations must no-op on an empty database.** CI runs `supabase start` against a fresh DB. The tier backfill keys off tier values and the HQ seed keys off company names, so both naturally select zero rows locally.

## Slices

### 1. Data migration — preserve the geography before dropping the source

Migration A, `company_locations.source`: extend the CHECK from `('scraped','manual')` to add `'tier_migration'` and `'hq_seed'`, so every synthetic row stays identifiable and reversible after `tier` is gone.

Migration B, tier anchors. For each geographically-tiered company **with no existing office in the tier's state**, find-or-create the anchor location and insert one `company_locations` row at `source = 'tier_migration'`:

| tier | anchor | inserts |
|---|---|---:|
| Utah/Silicon Slopes | Lehi, Utah | 20 |
| SF Bay Area | San Francisco, California | 29 |
| Boston | Boston, Massachusetts | 31 |
| Los Angeles | Los Angeles, California | 24 |
| San Diego | San Diego, California | 17 |
| Seattle | Seattle, Washington | 2 |
| Other Hubs (NYC) | New York, New York | 1 |

124 inserts. It **adds** and never replaces: the 103 companies that already have a real office in the tier's state keep their specific cities (Lehi/Provo/SLC), and the 7 whose recorded office contradicts the tier (Toast → San Mateo) gain the tier's city alongside it, because a company having several offices is what the join table is for. `Big Tech` (86) and `Other Hubs` (14) carry no geography and migrate nothing.

Migration C, HQ seed: public HQ cities for the 27 companies that would otherwise have none, at `source = 'hq_seed'`, keyed by company name. **The full 27-row mapping goes in the PR description for review before it is applied.**

Verification before the drop: re-run the recon script and assert 328/328 targeted companies have at least one location, and that every `tier_migration` row lands in the tier's state.

### 2. Query layer

- `getCompanies`: read `company_locations` → `locations` for the shown companies and add `offices: CompanyOfficeSummary[]` to `CompanyBaseSummary` (named to match `CompanyOffice` on the detail page, and to stay distinct from the existing `office_scopes`, which is targeted `target_companies` scopes and a different concept).
- Add `location_id, workplace_type` to the `fetchEmploymentRowsForCompanies` select (company-queries.ts:684). No new round trip.
- Carry per-person location onto the enrichment aggregate so every card field can be recomputed per location.

**Scoped counts must be contact-level, not count maps — measured, not assumed.** The cheap design was to emit a per-`(company, location)` count map and have the client sum over the selected locations. That is wrong: on the reference account **493 contacts hold roles at two or more different offices of the same company** (16 of them with both roles current), so summing double-counts those people. The client must union contact ids instead.

So each summary carries a compact located roster — one record per distinct `(company, contact, location)` with the flags the card needs (`is_current`, bench, alum, product alum, recruiter) — and the client unions over the active selection. Payload is bounded and small: **8,266 triples** on the reference account, derived from employment rows `getCompanies` already fetches. This also keeps the "location unknown" remainder exact, since unlocated people are simply the roster complement.

### 3. Filter logic (`company-filters.ts`)

- Drop the `tiers` facet; add `locations: string[]` where a value is `city:<location_id>` or `state:<name>`, plus a `none` sentinel for "No location set".
- A company matches if any of its offices matches any selected value. State values expand to their cities.
- URL round-trip: repeated `loc=` params (never comma-joined, same reasoning the tier param used, since a city label may contain a comma). Parse accepts both forms.
- Update the file's facet-contract header, which currently claims every facet reads a field `getCompanies` already returns.
- Remove `distinctTiers`, the tier search haystack entry, and the tier fixtures in `company-filters.test.ts`.

### 4. UI

- New grouped multi-select: states as selectable group headers that toggle all their cities, cities nested beneath, with search (409 distinct values). Built on the existing `useListboxPopover` so keyboard and portal behavior match `MultiSelect`.
- Card counts become location-scoped while a filter is active, leading with the scoped count and naming the remainder: `1 person in Lehi · 8 location unknown`. Only 53% of current roles carry a location (1,511 of 2,861), so the remainder line is what stops the card from appearing to lose people.
- Card href: pre-select the office when the active filter resolves to **exactly one** of that company's offices → `/companies/${id}?location=${locationId}`; otherwise bare `/companies/${id}`. The detail page already validates and consumes this param (`companies/[id]/page.tsx:109-119`), so no work is needed there.
- Remove the tier badge from `company-card.tsx`.

### 5. Retire tier

Strip every reference: `company-filter-bar.tsx`, `company-card.tsx`, `company-filters.ts`, `TargetInfo` / `deriveCompanyTarget` / `updateTargetCompany` in `company-queries.ts`, `bulk-import/route.ts`, `api-schemas.ts`, `mcp/tools/outreach.ts`, `mcp/lib/db.ts`, then regenerate `database.types.ts`.

Migration D drops the column.

**Ordering constraint — this is the one thing that can break production.** Migration D must be applied **after** the new code is live, inverting the usual order. Rule 42's mechanism applies in reverse: old code selecting a dropped column gets PostgREST 42703, which supabase-js surfaces as `{data: null}` **without throwing**, so the companies page would render empty rather than error. Sequence: merge → `wait-for-deploy.mjs` confirms live → apply D. Migrations A/B/C are additive and safe to apply before merge.

### 6. Make office location editable after creation

The add-company modal collects an office location but nothing can edit one afterward, which is why 144 companies are stuck. Add office add/remove on the company detail page, writing `source = 'manual'`. Without this the feature is still bundle-shaped: a user who mistypes a city, or adds a company before knowing its office, has no recovery.

### 7. Tests and docs

- Unit: location matching, state expansion, `none` sentinel, URL round-trip, scoped-count derivation, the exactly-one-office href rule.
- Integration: client-side unscoped rollup equals the RPC (the drift guard above); migrations B/C apply against real schema.
- E2E: filter to a city, assert the row set and the scoped card count, click through and assert `?location=` is present; then filter to two cities and assert it is absent.
- Docs page (`public/docs/index.html`) and README: the companies filter set is user-visible copy and currently describes tier.
- Falsify each new test by breaking the code it covers before keeping it (rule 52: confirm the probe actually mutated the intended function).

## Risks

- **Anchor cities are assertions.** `SF Bay Area → San Francisco` is right for the metro and wrong for a company actually in San Jose. Mitigated by the `tier_migration` source value and by slice 6 making it correctable.
- **Scoped counts undercount by construction.** 34% of employment rows have no location at all and 1,235 are remote. The remainder line makes this visible rather than silent, but the scoped number is still a floor, not a census.
- **Losing `Big Tech`.** 86 companies carry it and it has no location equivalent; it is deleted with no replacement, per the decision on the ticket. It stays reachable in git history and in the Linear issue.

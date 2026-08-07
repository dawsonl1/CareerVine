# CAR-252 — "Target company" facet in the Companies secondary filter row

## Problem

`/companies` loads `scope: "in_play"` (page.tsx:155) — targeted companies **∪** companies
with any current non-bench contact. The list therefore mixes targets and non-targets, and
nothing in the filter bar addresses that distinction.

The five status chips only reach targets: `filterCompanies` ANDs on `c.target.status`, so
`target === null` rows drop out the moment any chip is on. There is no way to ask for
"companies I know someone at but have not targeted" — the set you work when deciding what
to target next.

## Design

A `targeting` facet in the secondary (collapsible) row, as a `MultiSelect` matching the
traction / tier / contacts / alumni controls:

| value        | label          | predicate            |
| ------------ | -------------- | -------------------- |
| `target`     | Target company | `c.target !== null`  |
| `untargeted` | Not a target   | `c.target === null`  |

Unchanged from the CAR-245 facet contract: empty means any, values OR within the facet,
facets AND across, and the two values exhaustively cover the dimension so selecting both
equals selecting neither.

`c.target` is `deriveCompanyTarget`'s output, which is null both when no `target_companies`
row exists AND when every scope row is soft-untargeted (`is_targeted = false`). "Not a
target" is accurate for both, which is what the card already shows.

### The status-chip overlap, and why it is not CAR-248 again

`target_companies.status` has a CHECK pinning it to the five `TARGET_STATUSES`
(`supabase/database-reference/schema.sql:2173`), so "Target company" is reachable today as
"all five chips selected". That redundancy is worth naming, because CAR-248 just removed a
control for looking like this. It is a different shape:

- CAR-248's defect was two controls in one row over one dimension with **different
  combining semantics** — the dropdown ORed, the chip ANDed — and nothing on screen said
  which. Here both controls OR within themselves and AND across, uniformly, so
  "Target company" + "Applied" behaves exactly as it reads.
- `untargeted` is not expressible at all today. That is the capability being added. Its
  `target` sibling comes along **by contract**: a facet has to cover its dimension for
  "select everything = select nothing" to hold, and a one-value facet is a checkbox, not
  a dropdown.

### Interaction with `statusChipCounts`

`statusChipCounts` clears only `statuses`, so the new facet applies to the chip counts.
With "Not a target" selected every chip reads 0 — truthful, and exactly the promise the
counts make ("what I get if I click this"), since clicking a status chip there does yield
nothing.

## URL

New param `targeting`, comma-joined like the other enum facets, validated against the value
set so an unknown value falls through to `[]` (= any) rather than throwing. No legacy
spelling to migrate: the param is new, and every existing link parses to `[]`, which is the
absence of the filter.

## Files

- `careervine/src/lib/company-filters.ts` — `TARGETING_FILTERS`, `CompanyFilters.targeting`,
  `EMPTY_COMPANY_FILTERS`, `filterCompanies`, `hasActiveCompanyFilters`, parse + serialize.
- `careervine/src/components/companies/company-filter-bar.tsx` — the MultiSelect (first of
  the selects, since target-ness is the coarsest cut and sits nearest the status chips it
  relates to) + `secondaryActiveCount`.
- `careervine/src/__tests__/company-filters.test.ts` — facet behavior, both-equals-neither,
  active-filter detection, round-trip.
- `careervine/README.md` + `careervine/public/docs/index.html` — both enumerate the
  secondary row's menus; both go stale on this change.

## Verification

`npm run test`, `npm run check:conventions`, `npm run build` from `careervine/`.

No migration, no query change: `target` is already on every `CompanySummary` the page holds.

## Note

CAR-251 is in flight on this same row (tier → location filter). Expect a merge in
`company-filter-bar.tsx` and `company-filters.ts`; whichever lands second merges `main` in
first.

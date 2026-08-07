# CAR-248: fold "works there now" into the contacts dropdown

## Problem

The Companies secondary filter row has two controls that both answer "what do I
know about people at this company", and they read as competing:

- **`Contact works there now`** — a chip that ANDs (`current_count > 0`).
- **`Any contacts / With contacts / No contacts yet`** — a dropdown that ORs.

"With contacts" and "works there now" overlap. Worse, the difference that makes
them coexist — one narrows the set, the other widens it — is invisible in the UI.
CAR-245's own code comment argues the toggle has to stay a chip *because* it
narrows; the honest read is that contact presence should have been one facet with
three values from the start.

## Change

Retire the toggle. The contacts dropdown becomes the single place contact
presence is expressed, with three values that OR like every other facet:

| value | label | predicate |
| --- | --- | --- |
| `current` | Contact works there now | `current_count > 0` |
| `former` | Contact worked there before | `former_count > 0` |
| `none` | No contacts yet | `current_count + former_count === 0` |

The counts come from `company_network_counts` (CAR-229): a non-bench contact is
counted in exactly one of current/former **per company** (current wins across
multiple roles), and bench contacts land in neither — so `none` continues to keep
bench-only companies, matching today's `none`.

`current` and `former` are not exclusive (different people), which is the honest
reading of the labels and keeps the union clean:

- `current + former` = the old `with`.
- `current` alone = the old toggle.
- all three = everything = none selected. The facet contract holds.

Nothing is lost. The only combination that disappears is `current=1` AND
`contacts=none`, which matched nothing.

## Files

1. **`careervine/src/lib/company-filters.ts`**
   - `CONTACTS_FILTERS` → `["current", "former", "none"]`.
   - Drop `currentOnly` from `CompanyFilters`, `EMPTY_COMPANY_FILTERS`,
     `hasActiveCompanyFilters`, `filterCompanies`, `serializeCompanyFilters`.
   - `filterCompanies`: contacts predicate switches on the three values.
   - `parseCompanyFilters` — legacy URL migration (see below).
   - `serializeCompanyFilters` — stop emitting `current`, but keep deleting it
     from `base` so a stale param cannot outlive the filter it was folded into.

2. **`careervine/src/components/companies/company-filter-bar.tsx`**
   - Delete the `Contact works there now` chip and its `UserCheck` import.
   - Three options in the contacts `MultiSelect`.
   - `secondaryActiveCount` loses the `currentOnly` term.

3. **`careervine/src/__tests__/company-filters.test.ts`** — rewrite the contacts
   and current-employment blocks, the round-trip cases, and add legacy-link cases.

4. **Copy drift** — two surfaces describe the retired chip and both are updated:
   - `careervine/public/docs/index.html` — the "Filter by stage, then refine"
     card listed "whether a contact works there right now" as its own refinement.
   - `careervine/README.md` — the Companies filter bullets said "whether you
     already know someone inside, whether one of your contacts works there right
     now", i.e. described exactly the overlap this ticket removes.

## URL back-compat

Links are shareable, and CAR-245 already paid for one migration here, so old
links keep working:

- `contacts=with` → `["current", "former"]`.
- `current=1` → narrows the parsed set to `["current"]` when that set is empty
  or already contains `current`. Those are the only states a legacy link can be
  in (`current=1` alone, or with `contacts=with`), and both map exactly.
- `current=1&contacts=none` was self-contradictory and matched nothing; it is
  inexpressible in the new facet and resolves to `none`. Documented at the call
  site rather than special-cased.
- `contacts=any` keeps failing validation → `[]`, unchanged.

## Verification

- `npm run test` — 3739 passed / 343 files.
- `npm run check:conventions` — clean.
- `npm run test:integration` — 54 passed / 8 files (local Supabase stack).
- `npm run lint`, `npm run build`, `tsc --noEmit` — clean.
- Falsification pass on the migration: stubbing out the `current=1` branch fails
  exactly the three legacy-link tests that assert it, so they are load-bearing
  rather than vacuous (rule 52).

# CAR-245 — Companies filters: live status counts, alumni + current-employment facets, multi-select dropdowns

## Why

Three defects/gaps in the Companies filter bar (`src/components/companies/company-filter-bar.tsx`,
`src/lib/company-filters.ts`):

1. **The status chip counts lie once a secondary facet is on.** `countByStatus(companies)` runs over
   the whole loaded list, so with `tier=Utah/Silicon Slopes` applied the Researching chip still reads
   314 while the list below shows a fraction of that. A count next to a toggle is a promise about what
   clicking it yields.
2. **Two facets are missing.** There is no alumni facet (only "alum in product"), and "With contacts"
   matches a company where the only person you know *left* — there is no way to ask for companies
   where someone is there **now**.
3. **The facet dropdowns are single-select.** You cannot ask for two tiers, or for both "Replied" and
   "Call done".

## Shape

### Filter model (`src/lib/company-filters.ts`)

Facet values become arrays; empty = any. Values inside one facet OR together, facets AND with each
other — the standard faceted-search contract, and the same one `statuses` already follows.

```ts
export type ContactsFilter = "with" | "none";     // was "any" | "with" | "none"
export type AlumniFilter = "with" | "without";    // new

interface CompanyFilters {
  q: string;
  statuses: TargetStatus[];
  traction: OutreachStage[];   // was OutreachStage | null
  tiers: string[];             // was tier: string | null
  contacts: ContactsFilter[];  // was ContactsFilter ("any" is now the empty array)
  alumni: AlumniFilter[];      // new — alum_count > 0 / === 0
  currentOnly: boolean;        // new — current_count > 0
  productAlum: boolean;
}
```

Predicates:

- `traction` — `c.traction` must be in the set (a null-traction row never matches a non-empty set,
  as today).
- `tiers` — `c.target?.tier` must be in the set.
- `contacts` — `"with"` = `current_count + former_count > 0`, `"none"` = `=== 0`. They are
  complements, so selecting both is the same as selecting neither; that falls out of the OR and needs
  no special case.
- `alumni` — `"with"` = `alum_count > 0`, `"without"` = `=== 0`. Note `alum_count` counts alumni
  among **current** non-bench contacts (`company-queries.ts` enrichment pass), which is what the card
  badge shows, so the facet and the badge agree.
- `currentOnly` — `current_count > 0`. `current_count` is non-bench contacts (`active` + `prospect`)
  with a current role at the company, which is exactly "a contact or prospect works there now".

**URL params stay singular and comma-joined** (`?traction=replied,call_done&tier=Utah,Big+Tech`), so
every link shared before this change still parses: a single value lands as a one-element array, and
the retired `contacts=any` fails validation and falls through to the empty array, which *means* any.
New params: `alumni=with|without`, `current=1`.

### Counts that follow the facets

```ts
/** Every active facet applied EXCEPT the status chips themselves. */
export function statusChipCounts(rows, f) {
  return countByStatus(filterCompanies(rows, { ...f, statuses: [] }));
}
```

`countByStatus` stays the primitive (already tested). Clearing `statuses` rather than the whole
filter is what makes each count read as "what I get if I click this" while a chip that is already on
does not shrink the others. The search box is included, deliberately: it ANDs like any other facet,
so excluding it would make the counts wrong in the one case the user is looking hardest.

### Multi-select control

`select.tsx` carries a lot of hard-won popover behavior (portal into the modal surface, Escape claimed
in the capture phase only while the trigger holds focus, reposition on scroll/resize,
`aria-activedescendant` navigation with focus never leaving the trigger). Duplicating that into a
second component means the next fix lands twice, so:

- **Extract** the mechanics into `src/components/ui/listbox-popover.ts` (`useListboxPopover`), used by
  both. `select.test.tsx`'s 25 tests are the proof the extraction changed no behavior — they must pass
  untouched.
- **New** `src/components/ui/multi-select.tsx`: `values: string[]`, `onChange: (values) => void`,
  `role="listbox"` + `aria-multiselectable`, Enter/Space **toggles** and leaves the list open, a
  leading "any" option that clears the selection (keeping parity with today's `Any traction` row),
  trigger label = the empty label / the one selected label / `N <noun>`.
- Add `MultiSelect` to `select-aria-label.test.ts`'s `GUARDED` list so its call sites are held to the
  same accessible-name rule. That test's plausibility check greps `value=`, which has to widen to
  `value=|values=` or it will flag every MultiSelect tag as a scanner failure.

### Filter bar layout

Secondary row becomes: `[alum-in-product chip] [works-there-now chip] [traction] [tier] [contacts]
[alumni] [Clear all]` — chips first, then dropdowns. The alumni dropdown is hidden without school
affinity for the same reason the alum-in-product chip is (CAR-213): without a school `alum_count` is
always 0, so "With alumni" would match nothing and "Without" everything.

`secondaryActiveCount` counts the new facets so the collapsed "Filters" badge stays honest.

## Files

| File | Change |
| --- | --- |
| `src/lib/company-filters.ts` | array facets, `alumni` + `currentOnly`, `statusChipCounts`, param round-trip |
| `src/components/ui/listbox-popover.ts` | new — shared popover/keyboard mechanics |
| `src/components/ui/select.tsx` | re-point at the hook, no behavior change |
| `src/components/ui/multi-select.tsx` | new |
| `src/components/companies/company-filter-bar.tsx` | multi-selects, two new controls, badge count |
| `src/app/companies/page.tsx` | `statusChipCounts` instead of `countByStatus` |
| `src/__tests__/company-filters.test.ts` | rewrite for arrays; new facets; legacy-URL parsing |
| `src/__tests__/multi-select.test.tsx` | new |
| `src/__tests__/select-aria-label.test.ts` | guard MultiSelect |
| `careervine/public/docs/index.html` | re-check the Companies filter copy against the new facets |

## Verification

- `npm run test`, `npm run check:conventions`, `npm run test:integration`, `npm run build` from
  `careervine/`.
- Falsify the new tests: break each predicate in turn and confirm the test that owns it fails
  (rule 52 — print the diff, do not trust a clean probe).
- Browser-verify the filter bar: this is layout + a new interactive control, which is the
  high-risk case rule 13 reserves previews for.

## Out of scope

No schema change, no query change — every facet reads a field `getCompanies` already returns.

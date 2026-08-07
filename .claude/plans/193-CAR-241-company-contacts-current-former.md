# CAR-241 — Company page: split current vs former employees, collapse former by default

## Problem

`/companies/[id]` renders one flat contacts list built from `[...current, ...former]`
(`pipeline-layout.tsx`, `filteredPeople`). Everyone who works at the company and everyone who
used to are interleaved, split only by network tier ("Your network" / "Prospects"), with a small
"Former" badge as the only per-row signal. On a company with real scrape history the people you
can actually reach inside the company are buried under people who left.

## What already exists (no data work needed)

- `getCompanyDetail` returns disjoint `current` / `former` / `bench` lists. A boomeranger is
  current, not former (`company-queries.ts`: `for (const id of agg.current) agg.former.delete(id)`
  on the summary side, `isCurrent` set on the detail side).
- `fetchCompanyScopes` slices all three per location facet, so every scope block already carries
  its own `former`.
- `/outreach` already ships this exact disclosure: `Former employees (N)`, collapsed, chevron
  toggle (`app/outreach/page.tsx:352-363`). The company page should match that label and shape
  rather than invent a second vocabulary.
- The bench disclosure (`BenchSection`) is the in-file precedent for a collapsed group at the
  bottom of this same list.

## Design

Contacts section becomes three tiers of disclosure, in this order:

```
Contacts                                   47
[ search ]

YOUR NETWORK   3          <- current employees only
  rows…
PROSPECTS      9          <- current employees only
  rows…

▸ Former employees (35)   <- NEW, collapsed by default
     (expanded: same YOUR NETWORK / PROSPECTS grouping inside)

▸ 6 archived (hidden from list)   <- existing bench section, unchanged
```

Decisions:

1. **Tier grouping is preserved inside the former group.** The existing comment in
   `pipeline-layout.tsx` is load-bearing: the teal avatar ring only reads as "prospect" when
   network and prospect contacts live in distinct groups. A flat former list would make the ring
   ambiguous. So both current and former render through one shared group renderer.
2. **The header count stays current + former.** The collapsed toggle names the remainder, so the
   arithmetic is visible on screen (12 shown + 35 former = 47). Counting only what is expanded
   would make the number move when a disclosure opens.
3. **Search must never hide a match.** `search` filters current and former with the same
   predicate, and the former group auto-expands while a query is active (render-phase prev-state
   sync, the pattern already used by `RecruitingPanel`'s expanded-stage reset). Clearing the
   query collapses it back to the default. A manual toggle still wins until the searching flag
   flips.
4. **Empty states stay honest.** The section-level empty state only fires when current AND former
   are both empty. A company with former employees only shows a "no current employees" line above
   the toggle rather than an empty column or a false "no contacts" claim.
5. **The per-row "Former" badge stays.** It is redundant with the group heading for the first
   screenful, but it is the only anchor once a long expanded former list scrolls its heading off.

## Files

- `careervine/src/components/companies/pipeline/pipeline-layout.tsx` — the whole change:
  split `filteredPeople` into `filteredCurrent` / `filteredFormer`, extract the tier-group
  renderer, add `FormerSection`, rework the empty states.
- `careervine/src/__tests__/company-contacts-former-collapse.test.tsx` — new jsdom render test.
- `careervine/public/docs/index.html` — the "Roster by persona" feature card currently claims
  "Current and former employees grouped into your network versus prospects", which stops being
  true here (docs-drift rule).

## Verification

- New test: former hidden by default; expands on click; a search matching only a former employee
  surfaces them without a click; former-only company does not render the no-contacts copy;
  current employees are never swallowed by the collapsed group.
- `npm run test`, `npm run check:conventions`, `npm run build` from `careervine/`.

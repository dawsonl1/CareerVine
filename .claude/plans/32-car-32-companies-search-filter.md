# 32 — CAR-32: Companies page search bar + filter system

**Ticket:** [CAR-32](https://linear.app/career-vine/issue/CAR-32/add-search-bar-and-filter-system-to-the-companies-page)
**Branch:** `dawson/company-page-search-filter-f71991` → PR to `main` (multi-file, cross-cutting → PR path per rule 19)

## Context

`careervine/src/app/companies/page.tsx` is a client component with two views:

- **Targets** — `getCompanies(userId, { targetsOnly: true, sort, minContacts: 1 })`; full in-memory list of `CompanySummary` rows with sort dropdown. **No search, no filters.**
- **All** — server-side name-only search (`.ilike` on `companies.name`, 250 ms inline debounce); deliberately renders nothing until you type (thousands of past-employer rows).

`getCompanies` already aggregates everything filterable into memory per company: `current_count` / `former_count` / `bench_count`, `target: { status, tier, program_name, next_app_date, priority_score, ... } | null`, and `traction: OutreachStage | null` (targets view only). Companies **can** exist with zero contacts (CAR-18); target companies are unioned in regardless of contact count.

Schema reality check (things the ticket guessed at that don't exist): companies have **no** industry/size/location columns. Location lives in `company_locations`/`locations` (already a facet on the company **detail** page), industry lives on `contacts`. The bundle `network_tier` (`prospect`/`bench`) is a payload field, not a company column — it surfaces as the existing `bench_count`. So the real, data-backed facets are: **target status, traction stage, tier label, contact presence**.

## Goals

1. Search bar on the **targets** view (the view that actually lacks one) — instant, client-side, case-insensitive over name + program name + tier label.
2. Filter system on the targets view: status, traction, tier, contacts-presence — all combinable with search (AND semantics).
3. Filters and search encoded in the **URL** (`router.replace` + `useSearchParams`, the canonical idiom from `companies/[id]/page.tsx`) so state survives the back button from a company detail page and links are shareable.
4. Clear-all affordance + empty state when nothing matches.
5. Pure, unit-tested filter logic.

## Non-goals

- Faceting the **all** view beyond its existing server-side name search (non-target companies have no target metadata; counts-based filtering there can be a follow-up if ever wanted).
- Location or industry facets on the list page — no data on the `companies` grain; the detail page already handles location.
- Pagination / virtualization (list sizes are fine; separate concern).
- Server-side filter pushdown — the full aggregate is already in memory; client filtering is strictly faster here.

## UX design

One compact toolbar row under the view toggle (replacing the current lone sort `<Select>` placement), M3 tokens throughout, no clutter:

```
[ 🔍 Search companies…            ✕ ]   [ Sort ▾ ]
( Status ▾ ) ( Traction ▾ ) ( Tier ▾ ) ( Contacts ▾ )   Clear filters
```

- **Search input** — copy the Contacts page input styling (`h-12 pl-11 bg-surface-container-low rounded-full border-outline-variant focus:border-primary`, absolute `<Search>` lucide icon). `✕` clear button appears when non-empty. `useDeferredValue` for the filtering pass (matching Contacts), no timers needed client-side.
- **Status** — multi-select chip row or dropdown of the 5 `target.status` values, using existing `STATUS_LABELS`/`STATUS_STYLES` maps already at the top of the page. Chips mirror the Contacts tier-pill pattern (`aria-pressed`, live counts per status).
- **Traction** — single-select `<Select>` of `OutreachStage` values (labels from `STAGE_LABELS` in `@/lib/stage-derivation`), "Any" default.
- **Tier** — single-select `<Select>` whose options are the **distinct `target.tier` values present in the loaded data** (free-text labels like "Big Tech", "Utah/Silicon Slopes"), "Any" default. Hidden if <2 distinct tiers exist.
- **Contacts** — single-select: Any / With contacts / No contacts yet (`current_count + former_count > 0` vs `=== 0`).
- **Clear filters** — text button, visible only when any facet or search is active; resets URL params in one `router.replace`.
- **Result count** — small `text-on-surface-variant` line ("12 of 47 companies") when filters are active, so filtering is legible.
- **Empty state** — reuse the existing empty-card pattern: "No companies match — try clearing filters" with an inline clear action.
- **All view** — keeps its server-side search but swaps to the same styled search input component for visual consistency. Facet controls hidden in this view.

## Architecture

### New: `careervine/src/lib/company-filters.ts` (pure, node-testable)

```ts
export type CompanyFilters = {
  q: string;
  statuses: TargetStatus[];   // empty = any
  traction: OutreachStage | null;
  tier: string | null;
  contacts: "any" | "with" | "none";
};

export function filterCompanies(rows: CompanySummary[], f: CompanyFilters): CompanySummary[];
export function distinctTiers(rows: CompanySummary[]): string[];
export function parseCompanyFilters(params: URLSearchParams): CompanyFilters;
export function serializeCompanyFilters(f: CompanyFilters, base: URLSearchParams): URLSearchParams; // preserves unrelated params (view, sort)
```

- `filterCompanies`: lowercase substring match on `name`, `target.program_name`, `target.tier`; then AND each active facet. Companies with `target === null` fail status/traction/tier facets only when those facets are active (targets view always has `target`, but keep it total/safe).
- URL param scheme: `?q=stripe&status=applied,interviewing&traction=warm_dialogue&tier=Big+Tech&contacts=none` alongside existing implicit view/sort state — `view` and `sort` also move into the URL in the same pass so the whole page state is restorable (cheap once the serialize helper preserves params).
- Parse is defensive: unknown status/traction values dropped, not thrown.

### Page changes: `careervine/src/app/companies/page.tsx`

- Replace `useState` for `view`/`sort`/`search` with URL-derived state (`useSearchParams` read + `router.replace` writes), keeping a local controlled input state for the search box with `useDeferredValue` feeding `filterCompanies`.
- Targets view: `const visible = useMemo(() => filterCompanies(companies, deferredFilters), [...])`.
- All view: unchanged data flow (server `.ilike` search, 250 ms debounce), `q` param shared with the same search input.
- Extract the toolbar into `careervine/src/components/companies/company-filter-bar.tsx` (props: `filters`, `onChange`, `tierOptions`, `statusCounts`, `view`) so the page stays readable — it's already 213 lines.

### Reuse cleanup (in scope, small)

`company-queries.ts:304–306` inlines its own ilike-escape regex — swap to the shared `escapeIlikePattern` from `src/lib/search-helpers.ts`.

## Implementation slices

Each slice compiles, tests green, committed to the branch; Linear comment per slice.

1. **Lib + tests** — `company-filters.ts` (types, `filterCompanies`, `distinctTiers`, parse/serialize) + `src/__tests__/company-filters.test.ts` (model: `search-helpers.test.ts`). Cover: case-insensitivity, multi-field match, each facet alone, AND combinations, `target === null` rows, param round-trip, unknown-value dropping, param preservation. Include the `escapeIlikePattern` reuse swap here.
2. **URL state wiring** — move view/sort/search/filters to `useSearchParams` + `router.replace` on the page; behavior otherwise identical (no visible filter UI yet). Verifies back-button restoration without UI noise in the diff.
3. **Filter bar UI** — `company-filter-bar.tsx`, search input on targets view, facet controls, clear-all, result count, empty state; unified search input in all view.
4. **Polish + ship** — `npm run test` + `npm run build` from `careervine/`, README product blurb (rule 7), sync `main` into branch, open PR with `gh`, link PR on CAR-32, mark Done after merge + branch cleanup.

## Testing

- **Unit (Vitest, node env)** — all of slice 1; this is where the real logic lives, matching the repo convention of pure-function tests (no component-render infra exists).
- **Manual/preview** — per rule 13, no default browser verification; this is standard list-filtering UI, Dawson reviews. Playwright MCP available if something looks off.

## Risks / notes

- `useSearchParams` in a client page requires a `<Suspense>` boundary in Next 14/15 app router — check whether the page already renders under one; wrap if not (build will flag it).
- `tier` is free text — distinct-value dropdown means the facet degrades gracefully as labels evolve; no enum to maintain.
- Keep `router.replace` (not `push`) so typing/filtering doesn't spam history — matches the `[id]` page idiom.

## Acceptance criteria (from ticket)

- [ ] Typing filters visible companies in real time (targets view).
- [ ] Multiple working facets, combinable with search (AND).
- [ ] Clearing search/filters restores the full list.
- [ ] Empty state when nothing matches.
- [ ] Unit coverage for filter/parse/serialize logic.
- [ ] Filter state survives navigation into a company and back.

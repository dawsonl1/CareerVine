# CAR-87 — Onboarding company picker: "Order by" dropdown

## Problem

The onboarding "Pick your first target company" step (`CompanyPickerStep` in
`careervine/src/components/onboarding/onboarding-flow.tsx`) renders the company
list in one fixed order (most BYU alumni first). Users can't re-sort. Dawson
wants an **Order by** dropdown on the right of the search bar with:
alphabetical, most BYU alumni in product roles, most BYU alumni, most contacts.

## Approach

1. **`src/lib/onboarding/company-picker.ts`** — extract the ranking into a
   reusable, pure `sortPickerCompanies(companies, key)`:
   - `type CompanySortKey = "alumni" | "productAlumni" | "contacts" | "alphabetical"`.
   - `COMPANY_SORT_OPTIONS` = the four labels in display order (default first).
   - Each key leads with its headline metric, then falls through the other
     alumni/contact signals, with an alphabetical final tiebreak.
   - `toPickerCompanies` now delegates to `sortPickerCompanies(mapped, "alumni")`,
     so the pre-sync default ordering is byte-for-byte unchanged (existing tests
     stay green).

2. **`CompanyPickerStep`** — add `sortKey` state (default `"alumni"`), apply it
   inside the existing `filtered` `useMemo` after the name-search filter. Wrap
   the search input in a flex row and drop a compact `SortDropdown` on the right.

3. **`SortDropdown`** — purpose-built compact control (pill height matching the
   search bar, not the h-14 form `Select`). Menu portals to `<body>` at a
   z-index above the onboarding modal so it never clips in the scroll container.
   Labelled, `role="listbox"`/`option`, check on the active option.

4. **Tests** — cover all four sort keys + no-mutation for `sortPickerCompanies`.

## Verification

- `npm run test` (Vitest) from `careervine/` — full suite green.
- `npm run build` — type-check + prod build green.
- UI is deep inside the gated onboarding flow; per rule 13 no live browser
  preview (not a high-risk layout restructure; logic is unit-tested).

## Out of scope / non-existent

- No schema or migration, no new domain, no Vercel env. Single-surface UI + a
  pure helper refactor.

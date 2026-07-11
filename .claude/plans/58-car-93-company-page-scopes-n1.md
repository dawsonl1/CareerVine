# CAR-93 — Eliminate the `fetchCompanyScopes` N+1

## Problem

`/companies/[id]` sits on "Loading…" too long. Dominant cost: `fetchCompanyScopes`
(`careervine/src/lib/company-scopes.ts`) calls `getCompanyDetail` **once for the base
roster, then once per location facet**:

```js
const facetDetails = await Promise.all(
  base.facets.map((facet) => getCompanyDetail(userId, companyId, { locationKey: facet.key })),
);
```

`getCompanyDetail` runs the **full** query set regardless of `locationKey` (companies,
company_locations, target_companies, contact_companies↦contacts `.limit(2000)`, emails +
schools + interactions chunked, `getContactStages` ~7 queries, notes). `locationKey` only
changes an in-memory filter at the very end (`scopedIds`, lines 814-844). So a company with
F facets does `1 + F` identical fetches, in a dependent waterfall (facets wait on base).

## Fix — derive facet blocks from `base` in memory

Everything a facet block consumes from `facetDetails[i]` is `scoped.current/former/bench`.
Those are derivable from `base.current/former/bench` because each `CompanyPerson` carries
`roles[]` with `location_id` + `workplace_type` — exactly the fields `scopedIds` filters on.

Predicate (mirrors `getCompanyDetail` lines 819-824), person is in facet iff any role matches:

```ts
function personInFacet(person: CompanyPerson, key: string): boolean {
  return person.roles.some((role) =>
    key === "remote"
      ? role.workplace_type === "remote"
      : key === "unknown"
        ? role.workplace_type !== "remote" && role.location_id == null
        : String(role.location_id) === key,
  );
}
```

Then per facet: `current: base.current.filter(p => personInFacet(p, facet.key))`, same for
former/bench. Slicing already-sorted arrays preserves order; bucketing (current/former/bench)
is location-independent, so this is exactly equivalent to the old per-facet scoping.

Result: **`1 + F` full query-sets → 1**, and the second dependent wave is gone.

## Equivalence argument (why membership + order are identical)

- Old: `getCompanyDetail(…,{locationKey:key})` builds full `peopleById`, then includes a
  person iff `scopedIds.has(id)` where `scopedIds` = contacts with ≥1 employment row matching
  `key`. Since `person.roles` == that contact's employment rows at this company,
  `person.roles.some(match)` ⇔ `scopedIds.has(id)`.
- Bucket assignment (bench by network_status, else current if any is_current row, else former)
  does not depend on scope, so filtering each base bucket is the same as scoping then bucketing.
- current/former sorted by alum-then-persona, bench by adjacency — both computed on base once;
  `Array.prototype.filter` preserves order.

## Changes

1. `careervine/src/lib/company-scopes.ts`
   - Delete the `facetDetails` `Promise.all` per-facet `getCompanyDetail` fan-out.
   - Add `personInFacet` helper (exported for tests) and slice `base` per facet.
2. Tests: `careervine/src/__tests__/company-scopes-facets.test.ts` (new)
   - Synthetic people across two locations + remote + unknown, multi-role people, bench/former.
   - Assert derived blocks' membership + order match the reference (old-scoping) computation.

## Out of scope

- Client-only render / auth `getSession()` wait on hard refresh (needs SSR/prefetch).
- Collapsing the ~4-round waterfall inside one `getCompanyDetail`.

## Verify

`npm run test` + `npm run build` from `careervine/`. No migration. No env var.

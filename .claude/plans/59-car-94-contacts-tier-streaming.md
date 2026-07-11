# CAR-94 — Contacts page: stream all three tiers (50 each up front, backfill after)

## Problem

Post-CAR-92, `loadContacts` (`careervine/src/app/contacts/page.tsx`) streams the active
tier, then **sequentially** refetches the full superset of all three tiers:

```js
await getContactsStreamed(user.id, ["active"], onPage);            // first paint
const everyone = await getContacts(user.id, {                      // heavy, blocking
  networkStatuses: ["active", "prospect", "bench"] });
setContacts(everyone); setAllTiersLoaded(true);
```

The superset re-pulls active a second time and drags the entire prospect+bench archive
(~2,000 rows for bundle users) through the 6-table `CONTACTS_SELECT` embed in one blocking
fetch, gating full-load on `stream(active) + full(all)`.

## Fix

Stream each tier independently, in parallel. `getContactsStreamed` already does a 50-row
first page then 1000-row pages in `name` order, so per-tier it paints the first 50 fast then
backfills.

```js
const byId = new Map<number, Contact>();
const flush = () => setContacts(
  Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)),
);
const TIERS = ["active", "prospect", "bench"] as const;
await Promise.all(TIERS.map((tier) =>
  getContactsStreamed(user.id, [tier], (rows) => {
    for (const r of rows as Contact[]) byId.set(r.id, r);
    flush();
    if (tier === "active") setLoading(false);   // first paint on active's first 50
  }),
));
setLoading(false);            // guard: no active contacts
setAllTiersLoaded(true);
```

Result: first ~50 of **each** tier land up front (parallel first pages), spinner clears on
active, the rest of every tier fills in behind, no duplicate active fetch, prospect/bench
arrive progressively instead of one blocking 2,000-row fetch.

### Why behavior is unchanged

- Display list is globally name-sorted (map → sort by name), same as the old superset.
- `tierCounts` still prefers `serverTierCounts` (head counts) until `allTiersLoaded`, then
  recomputes from the loaded superset — unchanged, and the superset is still fully loaded.
- `visibleContacts`/search/filter already scope to enabled tiers only — unchanged.
- `viewLoading` (toggle-before-loaded spinner) still works; in practice each tier has ≥50
  rows before its toggle is visible, so it rarely triggers.
- De-dupe by id (map) is harmless — a contact has one network_status, so tiers are disjoint;
  the map just makes re-sorts idempotent across page callbacks.

## Changes

1. `careervine/src/app/contacts/page.tsx` — rewrite `loadContacts` per above. Drop the
   `getContacts(all tiers)` call. `getContacts` stays (used by pickers elsewhere).
2. Tests: extend `src/__tests__/contacts-streamed-query.test.ts` (or a sibling) to assert
   per-tier streaming ranges and that the accumulator ends name-sorted with all tiers.

## Out of scope (separate ticket)

- Trimming `CONTACTS_SELECT` `*` → explicit columns (touches shared `Contact` type).

## Verify

`npm run test` + `npm run build` from `careervine/`. No migration, no env var.
Preview-verify the streamed fill on `/contacts` (high-ish risk: load-path rewrite).

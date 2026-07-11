# CAR-92 — Contacts page: stream the list so cards paint before the whole set loads

## Problem

On the Contacts page, no contact card renders until the **entire** active
network has been fetched. Two blockers:

1. `getContacts` (`src/lib/queries.ts`) paginates the joined query in a
   blocking loop and returns one atomic array — it resolves only after every
   page of the requested tier is accumulated.
2. `ContactsPage` (`src/app/contacts/page.tsx`) gates the whole list behind a
   single `if (loading)` full-page spinner that only clears once that atomic
   fetch resolves.

On large networks (~2,000 contacts on bundle accounts) this is a needlessly
long spinner before a single card shows.

## Fix

Progressive/streaming load of the active tier: paint the first small page
immediately, stream the rest in behind it (rendering below the fold).

### `src/lib/queries.ts`
- Extract the joined column set into `CONTACTS_SELECT` (shared by both
  fetchers so row shape stays identical).
- Add `getContactsStreamed(userId, statuses, onPage)`: fetches contiguous,
  name-ordered ranges; first page 50 rows (fast paint), subsequent pages 1000;
  invokes `onPage(rows)` per non-empty page and returns the full accumulated
  array. Contiguous ranges over the stable `order("name")` mean appending
  pages yields the same sort `getContacts` returns.

### `src/app/contacts/page.tsx`
- `loadContacts` streams the active tier via `getContactsStreamed`, appending
  each page to local state and calling `setContacts` + `setLoading(false)` so
  the first 50 unblock the list. The background all-tiers prefetch (globally
  name-sorted superset via `getContacts`) is unchanged, so tier toggles still
  filter in memory and the combined view stays globally alphabetical.

No schema changes. No behavior change to filtering, search, or tier toggles.

## Tests
- `src/__tests__/contacts-streamed-query.test.ts` — page sizing (50→1000),
  per-page callback order, empty-set skip, error throw.
- Full Vitest suite green.

# CAR-74 — Admin contacts card: full list, status filter, company search

## Audit conclusion

The per-user Contacts card on `/admin/users/[id]` is **accurate but silently truncated**. `GET /api/admin/users/[id]/contacts` does `.limit(100)` ordered by `created_at desc`, returns no total, and the UI has no pagination. Production check (read-only): bundle-injected accounts hold **2,000 contacts** (1,144 prospects + 856 bench), so the card shows ~5% of the list with no hint anything is missing. Nothing filters rows out otherwise — all three `network_status` tiers are included.

## Changes

### API — `src/app/api/admin/users/[id]/contacts/route.ts` (GET only)

- Query params: `q` (existing), `status` (`active | prospect | bench`, optional), `offset` (int ≥ 0, default 0). Page size stays 100.
- Return `{ contacts, total }` where `total` is the exact count under the current filters (`count: "exact"`).
- `status` → `.eq("network_status", status)`.
- Company search: `q` matches contact name **or** a company the contact has worked at. Two-step (PostgREST can't OR across an embedded resource):
  1. Resolve matching contact ids via `contact_companies` → `companies!inner(name ilike %q%)` + `contacts!inner(user_id eq target)`, capped (500 ids).
  2. Main query: `.or("name.ilike.%q%,id.in.(…ids)")`.
- Select adds `contact_companies(title, is_current, companies(name))`; response rows gain `title` and `company` (current role preferred, else most recent).

### UI — `src/components/admin/contacts-section.tsx`

- Filter chips under the search box: **All / Active / Prospects / Bench** (single-select, All default).
- Search placeholder becomes "Search by name or company…".
- Row secondary line shows `title @ company` when known (email/linkedin stays as fallback), status suffix unchanged.
- Footer: "Showing X of Y" + **Load more** button when `contacts.length < total` (appends next offset page).
- Filter/search changes reset the list to page 0.

### Tests — new `src/__tests__/admin-contacts-route.test.ts`

Route-level tests with a mocked Supabase service client: status filter applied, company-match ids folded into the `.or()`, total returned, offset paging, and the `q` sanitizer.

## Out of scope

Contacts-page (user-facing) filters — already exist there; this is admin-only. No schema changes, no migration.

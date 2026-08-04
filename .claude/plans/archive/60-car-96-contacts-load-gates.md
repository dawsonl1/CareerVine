# CAR-96 — Contacts page: show cards at ~1s, not ~9s + de-triple the load + index the name sort

## Measured (real bundle account: 0 active / 1,144 prospect / 856 bench)

Browser Performance API on live `/contacts`:
- Shell paints ~180ms; contacts queries start ~160ms (auth is fine).
- First data page lands ~1s, **but no cards render until ~9.5s**.
- 36 Supabase requests (27 to `contacts`); 9 first-page requests = load ran 3×.

## Fix 1 — render gates (the ~9.5s, regression from CAR-94)

`careervine/src/app/contacts/page.tsx`.

**`loading`**: cleared only inside the active tier's `onPage` (`if (tier==="active") setLoading(false)`). `getContactsStreamed` skips `onPage` for an empty tier; a bundle account has 0 active → never clears until `await Promise.all` (~9s).
- Fix: in the `Promise.all` map, `await` each tier's stream and clear `loading` when the **active** tier settles (data or empty). Keep the in-callback clear for the active-with-data case (first page).

```ts
await Promise.all(TIERS.map(async (tier) => {
  await getContactsStreamed(user.id, [tier], (rows) => {
    for (const r of rows as ContactListItem[]) byId.set(r.id, r);
    flush();
    if (tier === "active") setLoading(false);   // active has data → show first page
  });
  if (tier === "active") setLoading(false);       // active settled (even empty) → unblock
}));
```

**`viewLoading`** (`tiersExist && !allTiersLoaded && (prospect|bench enabled)`): blanks the list until *all* tiers finish, hiding prospect rows already in memory.
- Fix: don't block when the enabled tiers already have rows. Gate on "nothing loaded yet":
  `const viewLoading = tiersExist && !allTiersLoaded && visibleContacts.length === 0 && (enabledTiers.has("prospect") || enabledTiers.has("bench"));`
- Result: once the first prospect page (50) lands (~1s), cards render and keep filling; the spinner only shows in the brief window before any row for the enabled tier exists.

## Fix 2 — stop the triple-load (app-wide)

`careervine/src/components/auth-provider.tsx`. `getSession()` then `onAuthStateChange` (INITIAL_SESSION + token event) each `setUser(new object)`; every page's load effect keys on the `user` reference → runs 3×.
- Fix: reference-stable updates. Only replace `user`/`session` when identity actually changes:
  - `setUser(prev => prev?.id === next?.id ? prev : next)` (keep same ref when id unchanged).
  - `setSession(prev => prev?.access_token === next?.access_token ? prev : next)` (tokens still update on refresh).
- Effect: downstream load effects run once per real identity. Cuts DB load 3× on every authed page and removes the query contention that slows the first page.

## Fix 3 — index the name sort

New migration `supabase/migrations/<ts>_contacts_user_status_name_idx.sql`:
```sql
create index if not exists contacts_user_network_status_name_idx
  on public.contacts (user_id, network_status, name);
```
Lets `where user_id and network_status in (...) order by name limit N` read index-ordered — no full-tier sort per page. (Keep the existing `(user_id, network_status)` index; the composite is a superset for the eq/in filter but Postgres may still prefer the narrower one for count-only queries, so leave it.)

## Tests

- `contacts-load-gates.test.ts` (or extend existing): a pure helper for the `viewLoading`/first-paint decision if extracted; at minimum assert `getContactsStreamed` empty-tier still resolves (already covered) and add an auth-provider dedupe unit test (`sameIdentity` helper) — reference stability when id unchanged, replacement when changed.
- Migration validated by rolled-back apply against prod (rule 32) before landing.

## Verify

`npm run test` + `npm run build` from `careervine/`. Apply migration on landing (rule 27). Re-measure `/contacts` in the browser: first cards ~1s, settle ~2s, ~9 contacts requests (not 27). High-risk load-path + auth change: browser-verify.

# CAR-113 — Calendar sync upsert missing onConflict (23505 + stale cache)

## Problem (confirmed from code + prod)

`/api/calendar/sync` throws Postgres 23505 on `calendar_events_user_id_google_event_id_key`
— 58× / 3 users since 2026-03-20, 2nd-most-frequent error group.

`src/app/api/calendar/sync/route.ts:147` calls `.upsert({...})` with **no
`onConflict`**. `calendar_events` has PK `id` (bigserial) + `UNIQUE(user_id,
google_event_id)`. Without `onConflict`, PostgREST conflict-targets the PK; the
payload has no `id`, so every "upsert" is an INSERT → existing event → unique
violation. The route logs + `continue`s (route.ts:166), so beyond the error
spam it's a **silent functional bug**: incremental sync returns only *changed*
events, each an existing row, so edits (reschedule / rename / attendees) are
dropped and the cache drifts from Google.

`calendar_event_contacts` is fine — its `PRIMARY KEY (calendar_event_id,
contact_id)` is the natural key, so its no-`onConflict` upsert already resolves.

## Fix (1 line + test)

`route.ts:147` — add the conflict target:

```ts
.upsert({ ...payload }, { onConflict: "user_id,google_event_id" })
```

Default (non-ignoreDuplicates) upsert → existing rows UPDATE, so calendar edits
propagate again and the 23505 stops. No schema change (constraint already
exists as named in the error).

## Tests (`npm run test`, `npm run build` from `careervine/`)

Extend `src/__tests__/calendar-sync-route.test.ts`:
- Turn the `calendar_events.upsert` mock into a spy.
- New test: sync one event → assert `upsert` called with
  `(objectContaining({ user_id, google_event_id }), { onConflict:
  "user_id,google_event_id" })`. Fails on current code, passes after the fix.

No migration. Single-file behavior change + regression test. Independent of CAR-112.

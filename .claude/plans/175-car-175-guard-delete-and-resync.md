# CAR-175: Guard the delete-and-resync pattern for application-owned calendar columns

## Background

The CAR-152 repair migration (`20260717040000_car152_calendar_sync_repair.sql`) deleted every `calendar_events` row in the -7d/+60d sync window and forced a windowed re-fetch from Google. The re-fetch re-INSERTs events with `source_gmail_thread_id` / `source_gmail_message_id` NULL, because Google never had those values: they are written by exactly one path, `POST /api/calendar/create-event`, when a user books a meeting from an Inbox thread. The linked-meeting chip for every affected thread was silently and irreversibly lost.

## What can't be done

**No relink.** The only record of the thread↔event association was the deleted rows themselves. The `meetings` table has no Gmail thread column (verified against `20260201214637_init.sql` and all later ALTERs), `meetings.calendar_event_id` only points the other way, and the plan is on Supabase free tier (no PITR). Any attendee+time match against email threads would be guessing, which the ticket explicitly bars. Skipping the optional relink.

## What will be done

### 1. Mechanical guard: `careervine/src/__tests__/migration-destructive-guard.test.ts`

A registry-driven lint test over `supabase/migrations/*.sql`, modeled on the house pattern (`conventions-doc.test.ts` for repo-file scanning, `check-conventions.test.ts` for "prove the guard trips"):

- **Registry** of application-owned columns per Google-synced cache table:
  `calendar_events` → `source_gmail_thread_id`, `source_gmail_message_id`, `meeting_id`, `zoom_link`. These are exactly the columns the sync upsert payload omits (which is why ordinary syncs preserve them, and why delete-and-resync destroys them).
- **Registry anti-rot checks**: every registered column must still exist in `database.types.ts`, and the sync route (`src/app/api/calendar/sync/route.ts`) must not write any of them in its upsert payload. If someone later adds a registered column to the sync payload, the registry (not just the scan) goes red and forces a decision.
- **Migration scan**: every `DELETE FROM calendar_events` / `TRUNCATE calendar_events` statement in the migrations dir must either (a) reference every registered app-owned column within the statement (an `IS NULL` guard or a save/restore CTE), or (b) carry an explicit `-- destructive-resync-audited: CAR-XX <reason>` annotation immediately above it. The already-applied CAR-152 migration is grandfathered by filename with a comment recording the damage.
- **Trip tests**: the scanner is exercised against inline SQL fixtures it MUST reject (bare delete, truncate, partial guard) and MUST accept (fully guarded delete, annotated delete), so the guard is provably live.

### 2. Point-of-use comment in the sync route

Short note at the upsert row builder in `sync/route.ts`: the payload intentionally omits app-owned columns; PostgREST `ON CONFLICT DO UPDATE` only touches present keys; see the guard test.

### 3. Conventions pointer

One entry in `careervine/CONVENTIONS.md` pointing at the guard test as the authoritative header for "application-owned calendar_events columns / destructive migration rules". The existing conventions-doc test auto-verifies the path.

## Verification

- `npm run test` from `careervine/` — new guard test green, trip fixtures red-then-caught, no regressions.
- Live rule-39-style synthetic check against the hosted instance (scoped to `car175-verify-%` google_event_ids, cleaned up after): insert one row with a thread id and one without, run the exact guarded-delete shape, confirm the thread-linked row survives, and confirm the inbox query shape (`.not("source_gmail_thread_id", "is", null)`) returns it. This is the ticket's "simulated delete-and-resync preserves the column" bullet, empirically.
- The linked-meeting chip path (`create-event` write → `inbox` read → `thread-list-tab` chip) is untouched by this change; the synthetic check covers its data layer.

## Out of scope

- Editing the applied CAR-152 migration (inert once applied; history recorded in the guard test header instead).
- The sync route's cancelled-event runtime delete (correct behavior: the event no longer exists on Google).

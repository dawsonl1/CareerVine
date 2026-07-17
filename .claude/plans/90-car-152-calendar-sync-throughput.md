# CAR-152 — Calendar sync correctness and throughput

Wave 4 · T15 of the Straight A's program (CAR-28). Retires findings R2.1, R2.3, R2.4, R3.2, R3.3.
Owns: `careervine/src/lib/calendar.ts`, `careervine/src/app/api/calendar/sync/route.ts`,
`careervine/src/__tests__/helpers/fake-calendar.ts` (new), two migrations.

## Problems being fixed

1. **R2.3 — no pagination.** `fetchCalendarEvents` makes one `events.list` call
   (`maxResults: 250`). Past page 1, events are silently dropped AND `nextSyncToken`
   is `undefined` (Google only returns it on the final page), so the route persists a
   null token and re-runs a full windowed fetch every sync.
2. **R2.4 — no recurring-event expansion.** Without `singleEvents: true`, a weekly
   recurring series arrives as ONE master event at the series start time; individual
   occurrences (and cancelled/modified instances) never ingest.
3. **R2.1 — pre-CAR-133 cross-tenant rows still in production.** CAR-133 fixed the
   unscoped `contact_emails` match going forward, but rows written before the fix keep
   foreign `contact_id`s, and incremental sync never revisits an unchanged event.
4. **R3.2 — 3–5 DB round trips per event.** Per event: contact match query, upsert,
   re-select of the row just upserted, N link upserts; cancellations delete row-by-row.
5. **R3.3 — missing hot-path indexes** on five query shapes exercised by the app/MCP.

## Design

### 1. `fetchCalendarEvents` (calendar.ts)

- Loop on `res.data.nextPageToken`, accumulating `items` across pages; take
  `nextSyncToken` from the **final** page only (that is the only page carrying it).
- `singleEvents: true` on every call (valid alongside `syncToken`; changing it is
  exactly why the repair migration must null existing tokens — a sync token is only
  valid under the settings that established it).
- `orderBy: "startTime"` on **windowed** fetches only (Google 400s on
  `orderBy` combined with `syncToken`, and `orderBy: startTime` requires
  `singleEvents`).
- Return shape unchanged: `{ events, nextSyncToken }` with all pages' events
  accumulated. 410 → `SYNC_TOKEN_EXPIRED` behavior unchanged (a 410 mid-pagination
  aborts the whole fetch, which is correct — partial pages are discarded).

Recurring instances then arrive as real instances with ids like
`{seriesId}_{occurrenceTs}` — unique under the `(user_id, google_event_id)` key —
and cancelled instances arrive as `status: "cancelled"` skeleton events that flow
through the existing cancellation-deletion path.

### 2. Route rewrite — page-level batching (route.ts:102–233)

Replace the per-event loop with one batched pass over the fetched set:

1. Partition events: `cancelled` (status `"cancelled"` with an id — deletion set;
   skipped from upserts so we don't write-then-delete) vs `upsertable` (id + valid
   start/end). Dedupe upsertable rows by `google_event_id`, **last wins** (a bulk
   upsert containing the same key twice fails with "ON CONFLICT DO UPDATE cannot
   affect row a second time").
2. Collect all attendee emails across the batch, **lowercased**, excluding the
   user's own `gmail_address` (compared case-insensitively). One
   `contact_emails.select("contact_id, email, contacts!inner(user_id)")
   .in("email", emails).eq("contacts.user_id", user.id)` query per batch — CAR-133's
   inner-join tenant scoping preserved verbatim; its test must stay green. Build an
   email→contact_id map for attribution. (Column-side normalization is the Gmail
   ticket's; local lowercasing has no dependency on it.)
3. One bulk `.upsert(rows, { onConflict: "user_id,google_event_id" })
   .select("id, google_event_id")` — the returned ids kill the per-event re-select.
4. Bulk `.upsert(linkRows, { onConflict: "calendar_event_id,contact_id" })` on
   `calendar_event_contacts` (composite PK, one call).
5. Cancellations: one `.in("google_event_id", ids)` select, then ONE
   `.in("calendar_event_id", ids)` delete on links and ONE `.in("id", ids)` delete
   on events.
6. Large batches chunked (emails at 200/query — PostgREST `.in()` rides the URL;
   rows at 500/upsert), so calls stay constant per chunk; test fixtures fit one chunk.

Net: a constant number of Supabase calls per event batch, independent of event count.

### 3. Repair migration — `20260717020000_car152_calendar_sync_repair.sql`

- `UPDATE gmail_connections SET calendar_sync_token = NULL` (all rows): tokens
  re-establish under `singleEvents: true` on next sync (route already falls back to
  the windowed fetch when the token is null; the 60-day window rebuilds the cache
  with expanded instances).
- The one-time cross-tenant repair CAR-133 omitted:
  - `UPDATE calendar_events SET contact_id = NULL FROM contacts c WHERE
    calendar_events.contact_id = c.id AND c.user_id <> calendar_events.user_id;`
  - `DELETE FROM calendar_event_contacts USING calendar_events ce, contacts c
    WHERE calendar_event_id = ce.id AND calendar_event_contacts.contact_id = c.id
    AND c.user_id <> ce.user_id;`

### 4. Index migration — `20260717030000_car152_hot_path_indexes.sql`

Each verified against live query shapes (existing indexes checked for overlap):

| Index | Serving | Why not already covered |
| --- | --- | --- |
| `interactions (contact_id)` | `db.ts:1121–1128`, `company-queries.ts:101/807`, `bundle-sync.ts:247` (`.eq/.in contact_id`) | FK has no index (init.sql only adds the FK) |
| `follow_up_action_items (user_id, is_completed, due_at)` | `db.ts:548–553` (eq user_id + eq is_completed + order due_at); prefix serves `db.ts:784/807`, `action-items.ts:240–245` | no index on the table at all |
| `meeting_contacts (contact_id)` | `db.ts:214–218/1133–1141`, `company-queries.ts:138`, `bundle-sync.ts:248`, ai-write/meetings route | unique idx leads with `meeting_id` |
| `email_messages (user_id, date DESC)` | `db.ts:806/837–842` (eq user_id + order date DESC without matched_contact_id) | existing idx is `(user_id, matched_contact_id, date DESC)` — middle column blocks the sort |
| `contact_emails (email)` | this route's `.in("email", …)`, `gmail.ts` activateContactByEmail, `resolve-contact` | unique idx leads with `contact_id` |
| `GIN email_messages (to_addresses)` | `backfillEmailsForContact` filters `.contains("to_addresses", [email])` (gmail.ts:483) — condition in the ticket is met | no GIN exists |

### 5. Fixtures & tests

**New `src/__tests__/helpers/fake-calendar.ts`** — a fake Calendar API surface
(`events.list`) implementing: multi-page responses via `pageToken`,
`nextSyncToken` only on the final page, param recording (to assert
`singleEvents`/`orderBy`/token usage), plus event builders (`makeEvent`,
recurring-instance and cancelled-instance helpers). Deliberately separate from the
Gmail ticket's fake-gmail file.

**New `src/__tests__/calendar-sync-batching.test.ts`** — mocks
`@googleapis/calendar` (factory → fake) and `@/lib/oauth-helpers` ONLY; the REAL
`fetchCalendarEvents` pagination loop and the REAL route batching run against a
recording fake Supabase service client:

- Two-page fixture: events from both pages ingest; only page 2's `nextSyncToken`
  persists to `gmail_connections`.
- Windowed fetch sends `singleEvents: true` + `orderBy: "startTime"`; token fetch
  sends `singleEvents: true`, no `orderBy`/window.
- Recurring series → instances upserted at real occurrence times with unique
  `google_event_id`s.
- Cancelled instance → flows to the bulk delete of links + events.
- Call-count constancy: a 2-event and a 6-event fixture produce the same number of
  service-client calls.

**Updated `calendar-sync-route.test.ts`** — mock plumbing adapted to the new call
shapes (bulk upsert returns a builder with `.select()`, bulk link upserts, `.in()`
deletes); all existing assertions keep their semantics, especially the CAR-133
cross-tenant scoping test.

## Sequencing

1. Plan (this file) → 2. calendar.ts fetch fix → 3. route batching rewrite →
4. fixtures + new tests, adapt existing tests → 5. two migrations →
6. `npm run test`, `tsc --noEmit`, `eslint --max-warnings 0`, `next build` →
7. rule-32 rehearsal of both migrations (BEGIN; SET LOCAL lock_timeout='3s'; …;
ROLLBACK;) against production → 8. PR `(CAR-152)` → stop for merge approval.
Post-merge (on go-ahead): `supabase db push --dry-run` → `supabase db push`
(rule 27), then confirm production sync path.

## Exit criteria (from the ticket)

- Two-page fixture: all events ingest, only page 2's token persists; recurring
  event yields instances at occurrence times; cancelled instance deletes.
- Constant Supabase calls per event batch; cross-tenant scoping test green.
- Repair + index migrations applied to production; no single-shot `events.list`
  remains in the ingestion path; each index's column order matches a real query.

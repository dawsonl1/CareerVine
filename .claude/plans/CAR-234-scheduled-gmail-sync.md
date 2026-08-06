# CAR-234 — Scheduled Gmail sync for premium accounts

Full sweep 3x daily (08/12/16 Mountain), narrow sweep every 20 minutes, both
triggered from the A1 box with `$CRON_TRIGGER_SECRET`.

Design rationale, cost model and the numbers behind the split live on the
ticket. This file is the build order.

## 1. Narrow scoping in the sync itself

`syncAllContactEmails` already pages contacts by id with a resume cursor and a
45s budget. Add `opts.contactIds?: number[]`, applied as `.in("id", ids)` on the
existing contacts query. Everything else (cursor, concurrency, watermark,
budget) is reused untouched.

This is the whole reason the narrow sweep is cheap: per-contact cost is one
`messages.list` scoped by `email_synced_through`, so a contact with nothing new
costs one call and zero `messages.get`.

## 2. Selecting the work

New module `careervine/src/lib/data/sync-targets.ts`:

- `getPremiumSyncUserIds(service)` — users whose `capabilitiesFor()` includes
  `mailbox:read`. Mirrors the `send-follow-ups` prefetch: one
  `gmail_connections` read, `filterActiveUserIds` for account status, then the
  capability map. Resolved through the capability layer, never raw flags
  (conventions §c).
- `getRecentlyTouchedContactIds(service, userId, days)` — union of:
  - contacts on an **active** `email_follow_ups` sequence,
  - contacts with **outbound** `email_messages` inside `days` (9).

  Both legs paginate (conventions §d). Returns a de-duplicated id array. An
  empty result means the user is skipped entirely rather than swept.

## 3. Two routes

`POST /api/cron/sync-gmail-full` and `POST /api/cron/sync-gmail-recent`.

Two routes rather than one with a `mode` flag, because the bearer path carries
no body signature: a handler that trusts its body must not opt in. Each route
picks its own work server-side, so the body is irrelevant to what runs.

Both: `withQStashVerification(withCronGuard(...), { allowCronBearer: true })`,
credential outside guard, `maxDuration = 60`.

- **full**: per user, paged `syncAllContactEmails` until cursor exhausted or the
  route's own wall-clock budget trips, then `syncThreadReplies` +
  `detectBounces`. Users not reached are reported, not silently dropped.
- **recent**: per user, resolve contact ids, skip if empty, one budgeted
  `syncAllContactEmails` with `contactIds`, then `syncThreadReplies`. No
  `detectBounces` — that is the full sweep's job and it is not scoped to a
  contact set.

## 4. Ops

`ops/gmail-sync/` with `install.sh` and four units.

**A1 runs systemd 249 with the box on Etc/UTC.** Inline `OnCalendar` timezones
need 252+, and hardcoded UTC hours drift an hour across DST. So:

- `careervine-sync-full.timer` → `OnCalendar=hourly`, and the service wrapper
  exits 0 unless `TZ=America/Denver date +%H` is `08`, `12` or `16`. Correct on
  both sides of a DST boundary without touching the box's timezone.
- `careervine-sync-recent.timer` → `OnCalendar=*:0/20`. No timezone concern.

Both `Persistent=true`. Secret read from the same place the send-watcher reads
it; do not add a second copy of it on the box.

## 5. Docs and inventory

- `route-auth-inventory.test.ts`: two new `allowCronBearer` entries. Fails CI
  until they exist, in both directions.
- `CONVENTIONS.md` §b: currently states the scheduling inventory as nine QStash
  schedules and nothing else. A1-timer-driven crons are a second mechanism and
  the section has to say so. The existing send-watcher is precedent but is
  described as a watcher, not a schedule.
- `cron-schedules-registry.test.ts` pins that prose and will go red.

## Tests

1. `contactIds` restricts the swept set and leaves paging/cursor behaviour intact.
2. Absent `contactIds` reproduces today's rows exactly (backward compat).
3. `getPremiumSyncUserIds` includes a premium user and **excludes** a
   modify-less one and an admin-disabled one. Non-premium must never sync, and
   that needs a test rather than an assumption.
4. `getRecentlyTouchedContactIds` returns both cohorts, de-duplicates the
   overlap, and excludes a contact whose only outbound is 10 days old.
5. Both routes 401 without a credential.
6. A user with no recent contacts is skipped, not swept.

## Verification

From `careervine/`: `npm run test`, `npm run check:conventions`, `npm run build`.
On A1: `systemd-analyze calendar` on both expressions, plus a dry-run of the
hour guard against a DST date.

# CAR-254 — Deleting a Google Calendar event never removed it from CareerVine

## Symptom

Dawson deleted a call in Google Calendar and pressed Sync. The event stayed in CareerVine and kept counting as a scheduled call on the Adobe card.

## Proof, from the Google API with his own credentials

```
events.get  Aug 7 event        -> http=200 status=cancelled     (he did delete it)
events.list showDeleted=false  -> 18 events, deleted one ABSENT
events.list showDeleted=true   -> 19 events, deleted one PRESENT status=cancelled
```

Database corroboration: the sync ran at `04:33:34` and stamped that `synced_at` on event 502, while event 372 still carried `2026-08-06 03:46:09`. It was neither updated nor deleted, because Google never mentioned it.

## Root cause

`fetchCalendarEvents` built its `events.list` params without `showDeleted`. Google's default is false, so a deleted event is omitted rather than returned as a `status: "cancelled"` skeleton.

The sync route's deletion handling keys on exactly that status:

```ts
const cancelledGoogleIds = events.flatMap((e) => e.status === "cancelled" && e.id ? [e.id] : []);
```

so the branch was **unreachable**. It has never fired in production.

The incremental (`syncToken`) path would have delivered deletions, but it never runs: `orderBy=startTime` on the windowed path is incompatible with Google returning a `nextSyncToken`, so no token is ever stored, so all 8 `gmail_connections` rows have `calendar_sync_token IS NULL` and the windowed path is the only path.

## Fix

`showDeleted: true` on the params. Everything downstream already handles it — `upsertable` filters cancelled entries out of the write set, `cancelledGoogleIds` collects them for deletion.

## Why the test had to live in a new file

`calendar-sync-batching.test.ts` already has "deletes a cancelled instance through the bulk cancellation path", and it passes — but it mocks `fetchCalendarEvents` and hands the route a hand-written cancelled event. It proves the branch *works*; it cannot prove the branch is *reachable*.

Demonstrated rather than asserted: with `showDeleted` removed as a probe, the new tests fail and **all 11 tests in the existing sync suite still pass**. Same trap `calendar-timezone.test.ts` documents for CAR-220.

## Stale data already in the cache

Measured Dawson's cache against live Google over the sync window (-7d/+60d): 28 local rows, 27 returned by Google, **5 stale**.

| Event | Google says |
| --- | --- |
| PH Volunteers - Monthly All Hands | cancelled |
| REL C 351 | cancelled |
| IHUM 202 | cancelled |
| Dawson <> Smita (Aug 7, the Adobe one) | cancelled |
| Product Hive Orientation (Sep 2) | **absent entirely** |

The four `cancelled` ones clean themselves on the next sync once this ships, including the Adobe one. The fifth is absent from Google's response even with `showDeleted=true`, so no status-based rule can catch it.

**Not built here, deliberately.** Cleaning that class means "delete local rows Google did not return", which is destructive and must be gated to the full-window fetch — on a delta fetch, "absent" means "unchanged", and the same rule would wipe the cache. That gate is easy to write and easy to get wrong, and it is worth Dawson's explicit go-ahead rather than being smuggled into a one-line-flag PR.

## Follow-up

`calendar_sync_token` never populating means every Sync is a full windowed refetch rather than a delta. Not a correctness problem once `showDeleted` is set, but avoidable API load.

## Verification

3 new tests (windowed path, incremental path, cancelled skeletons pass through), falsified by probe; 3826 unit tests; conventions; build.

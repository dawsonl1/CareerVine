# CAR-250 — One conversation, counted once

## Reported vs actual

Reported: Adobe's chip says "3 Calls Scheduled" and is counting former employees.

The former-employee half is **already correct**. Verified against production: Dan Hunt (contact 1469, event 518, Aug 10) is the actual former Adobe employee, every one of his Adobe `contact_companies` rows has `is_current = false`, and he is excluded from the count. CAR-244 and CAR-246 did that job and it holds.

The three that ARE counted all belong to Smita Verma (contact 103, genuinely current at Adobe):

| # | Source | Ref | When |
| --- | --- | --- | --- |
| 1 | `calendar_events` 372 | google `7gst…` | Aug 7 17:00Z |
| 2 | `calendar_events` 502 | google `cmk1…` | Aug 14 17:00Z |
| 3 | `meetings` 24 | `calendar_event_id = cmk1…` | Aug 14 11:00 (naive) |

**2 and 3 are the same conversation.** `meetings.calendar_event_id` holds the Google event id; `calendar_events.google_event_id` holds the identical string. The times differ only because `meeting_date` is a naive wall clock stored as UTC (CAR-206): 11:00 Mountain == 17:00Z.

Not a bug, checked: Smita has two `contact_companies` rows for Adobe because she has two real stints there (Jul 2019–Present current, Jan–Apr 2016 consultant former).

## Root cause

`getContactStages` keys call events to dedupe, and says so — but only across the two calendar legs:

```
calEvents     -> `cal:${e.id}`
calLinks      -> `cal:${l.calendar_event_id}`
meetingLinks  -> `mtg:${l.meeting_id}`     // own namespace
```

CAR-246 closed the `calendar_events.contact_id` vs junction overlap and left the meeting leg separate. Since `call_scheduled` / `call_done` deliberately carry EVENT counts rather than people counts, the duplicate is visible to the user rather than collapsing silently.

Scope: 9 of 23 production meetings carry a `calendar_event_id`, so any of them paired with its calendar event double-counts.

## Fix

Key a call by its Google event id whenever a leg has one, so the calendar row and its mirrored meeting land on the same key:

- select `google_event_id` on both calendar legs, `calendar_event_id` on the meeting leg
- key `g:<google_event_id>`, falling back to the existing `cal:<id>` / `mtg:<id>`
- fold the meeting leg in **first**, so the calendar event's `start_at` timestamptz overwrites the meeting's naive wall clock on a shared key. Only the timestamptz can be compared against `now`.

`calendar_events.meeting_id` looks like the same link from the other side and was considered, but it is dead: 0 of 120 production rows populated.

Covers `call_done` identically, since the fix is in the shared collection.

## Verification

- 4 new tests: one conversation counts once across all three legs; the surviving timestamp is the calendar event's; a meeting with no calendar event still counts on its own (guards over-collapsing, which would hit the 14 of 23 meetings that carry no event); and a call with a former employee still does not count (the reported symptom, asserted so a fix aimed at it cannot regress what was already right).
- Falsified: reverting the meeting key to `mtg:<id>` turns the first two red.
- Applied the same dedupe rule as SQL against production Adobe data: 3 keys collapse to 2.
- 3792 unit tests, conventions guard, build.

## Expected result

Adobe goes 3 → 2 immediately, then → 1 once the calendar sync runs and drops the Aug 7 event Dawson deleted in Google. Sync handles deletions already (`sync/route.ts` collects cancelled Google ids and deletes the local rows); event 372's `synced_at` simply predates the deletion. Opening the app triggers it.

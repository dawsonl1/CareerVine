# CAR-206 — Due dates render a day early and flip to Overdue at the wrong time

## Diagnosis (verified by execution, not inspection)

`follow_up_action_items.due_at` is `timestamptz`. Every writer writes a bare
`YYYY-MM-DD`; every edit form reads it back with `.split("T")[0]` to seed the
`DatePicker`. So the column is **semantically a calendar date** stored as an
instant.

Confirmed end-to-end against the local stack running the full migration chain:

| Probe | Result |
| --- | --- |
| `SHOW timezone` | `UTC` |
| `'2026-01-05'::timestamptz` | `2026-01-05 00:00:00+00` |
| PostgREST wire (real row, real insert) | `"due_at":"2026-01-05T00:00:00+00:00"` |

So `due_at.split("T")[0]` is exactly the date the user picked. That is the
invariant the whole fix rests on, and it is measured, not assumed.

`post_meeting_action_items` (the other table with a `due_at` in `init.sql`) was
dropped in `20260214092500_drop_post_meeting_action_items.sql`. One live table,
one column.

### Failure mode A — rendering

`new Date(due_at).toLocaleDateString()` reinterprets midnight UTC through the
local zone. Measured:

| TZ | `new Date("2026-01-05T00:00:00+00:00")` | `DatePicker` (`+"T00:00:00"`) |
| --- | --- | --- |
| America/Denver | **Jan 4** | Jan 5 |
| America/Los_Angeles | **Jan 4** | Jan 5 |
| UTC | Jan 5 | Jan 5 |
| Pacific/Auckland | Jan 5 | Jan 5 |

The card and the edit modal contradict each other on the same row.

### Failure mode B — "is it overdue?", two distinct broken idioms

**B1. Instant comparison** `new Date(due_at) < new Date()`. An item due *today*
is midnight UTC, which is before any later moment today, so it renders red from
local midnight onward for **every** user at or west of UTC, including UTC
itself. Sites: `contact-actions-tab.tsx:220` + `:129`, `meetings/page.tsx:614`,
`mcp/lib/db.ts:514`.

**B2. UTC "today"** `new Date().toISOString().split("T")[0]`. Measured:

* Denver, Jan 5 **18:00** local → `todayStr` = `2026-01-06`. Item due today
  classifies **Overdue**. The list reshuffles every evening at 17:00 Mountain.
* Auckland, Jan 5 **09:00** local → `todayStr` = `2026-01-04`. A genuinely
  overdue item due Jan 4 is **not** flagged, and lands in "This Week".

So the ticket title undersells it: west of UTC over-reports overdue, east of UTC
under-reports it.

Sites: `action-items/page.tsx:309`, `page.tsx:511`,
`contact-pending-actions-banner.tsx:59`.

### Failure mode C — week bucketing

`action-items/page.tsx:311-314` builds a **local** end-of-week
(`setHours(23,59,59,999)`) and then converts it back through
`.toISOString().split("T")[0]`, which pushes it a day forward west of UTC. In
Denver the "This Week" bucket runs one day long.

### Failure mode D — snooze-until-due

`page.tsx:674` `new Date(item.dueAt) > new Date()` — same instant comparison. At
18:00 Denver an item due *tomorrow* is not recognised as future, so the snooze
falls back to a full cadence cycle instead of the due date.

## Decision: keep `due_at` as `timestamptz`

The ticket asks for an explicit call. Keeping it, because the migration buys
nothing measurable:

1. **A `date` column does not fix the render bug.** ES parses a bare date-only
   string as UTC, so `new Date("2026-01-05").toLocaleDateString()` in Denver is
   still **Jan 4** (measured above, same table). Every render site needs the
   formatter either way, so the formatter is the fix, not a workaround for one.
2. **Zero behavioural delta.** With session TZ = UTC, `::timestamptz` stores
   midnight UTC and `::date` stores the same calendar date; both reach the
   formatter as the same `YYYY-MM-DD`.
3. So an in-place ALTER on a live column, a types regen, an MCP contract change
   and a rule-42 deploy window would buy no user-visible correctness.

What the `date` column *would* have bought is closing the one path that can put
a real time-of-day into the column: the MCP tools document `due_at` as "ISO
timestamp". That is closed directly instead, by normalising to the date part on
write, which is the cheaper half of the same guarantee.

## The fix

One module, `careervine/src/lib/due-date.ts`, holding the calendar-date
invariant. Formatting builds the date in **UTC** (`Date.UTC` + `timeZone:
"UTC"`) rather than parsing `+"T00:00:00"` as local, so the output cannot depend
on the viewer's zone at all — and DST transitions that skip local midnight
(Pacific/Apia, Dec 30 2011) cannot shift it either.

* `dueDateKey(value)` → `YYYY-MM-DD | null`
* `formatDueDate(value, options?, locale?)` → zone-independent display
* `todayDateKey(now?)` → **local** calendar today
* `isDueDateOverdue(value, now?)` → `key < todayKey`
* `shiftDateKey(key, days)`, `endOfWeekDateKey(now?)`

Then route every site through it:

* **Render (7):** `action-items/page.tsx:392,:777`, `page.tsx:535,536`,
  `contact-pending-actions-banner.tsx:73`, `meetings/page.tsx:615`,
  `contact-actions-tab.tsx:223`, plus the hand-rolled-but-correct `formatDate`
  in `transcript-action-suggestions.tsx` (dedupe onto the chokepoint).
* **Logic:** `action-items/page.tsx` today + endOfWeek + three bucket filters,
  `page.tsx` today/isOverdue/snooze, the banner, `meetings/page.tsx`,
  `contact-actions-tab.tsx` sort + badge, `mcp/lib/db.ts` due filters.
* **Write:** normalise `due_at` to a date key in the MCP upkeep tools and fix
  the `.describe()` that currently says "ISO timestamp".

### Deliberate behaviour change

`contact-actions-tab.tsx` and `meetings/page.tsx` currently mark an item due
**today** as overdue (red). The action-items page and the home dashboard do not.
Standardising on `dueDate < today` makes all four surfaces agree; items due
today stop rendering red on those two.

`sortByPriorityThenDate` is left alone: it compares instants, and for
midnight-UTC values instant order equals date order, so it is already correct.

## Tests

`src/__tests__/due-date.test.ts` for the module, plus render/logic assertions.
TZ is pinned by mutating `process.env.TZ` (verified to take effect at runtime on
Node 26) and the clock by `vi.setSystemTime`. Required assertions:

* `2026-01-05` renders as Jan 5 in `America/Denver`, `America/Los_Angeles`, `UTC`
* card and edit modal agree on the same row
* item due today is not Overdue at 18:00 local
* item due yesterday is Overdue at 09:00 local
* Auckland 09:00: an overdue item is still flagged (guards the overcorrection)

Every test is falsified against the pre-fix code before being kept — per the
CAR-191 lesson, a test that never went red proves nothing.

## Verify

`npm run test`, plus `TZ=America/Denver` and `TZ=Pacific/Auckland` runs;
`npm run lint`, `npm run typecheck`, `npm run check:conventions`, `npm run build`.

## Found by the TZ sweep, NOT fixed here

The mandated `TZ=` runs surfaced three things outside the due-date domain. Two
test-fixture failures were fixed in this branch because the ticket's own
verification could not otherwise pass. The rest are separate defects.

**Fixed here (test-only, no product change):**

* `profile-helpers.test.ts` — two edge cases pinned `derived` to a UTC instant
  while `now` was local, so in Auckland the fixture meant something different
  than intended and the test failed on itself. Both sides are local now.
* `ai-untrusted.test.ts` — prompt snapshots embed `toLocaleDateString()` output.
  Pinned to UTC, which is what the server actually runs in.

**Not fixed here, each needs a decision about what the number means:**

* **Networking streak counts UTC days against a local "today".** `activeDays` in
  `data/home.ts` buckets activity timestamps by splitting on `"T"` (UTC), while
  `deriveNetworkingStreak` compares against `startOfDay(nowIso)` (local). The
  dashboard calls this from the browser and MCP calls it server-side, so the same
  user can get two different streaks. Fixing it means choosing whether a streak
  day is a UTC day or the user's day, and there is no stored user timezone to
  compute the latter from server-side.
* **`days_overdue` mixes bases the same way.** `deriveDueFollowUps` builds
  `dueDate` from a `lastTouch` value and compares it against a local
  `startOfDay`; `data/home.ts` and `data/follow-ups.ts` repeat the pattern for
  `daysSinceTouch`, which feeds the neglected-contacts rule. Reproduces under
  `TZ=Asia/Kolkata` (a half-hour offset), on `main`, as an off-by-one. Both
  source columns are `timestamptz` holding real instants, so the fix depends on
  whether the counter means calendar days or elapsed days. Four sites across a
  rule family, changing a user-visible number on the home dashboard and in
  `list_due_followups`.
* **`prod-drift-check-script.test.ts` has a TOCTOU race.** `freePort()` binds,
  reads the port, closes, and returns it; the script then tests whether that port
  is held. Anything can claim it in the window. Observed failing once in ~13
  full-suite runs on this branch and not reproduced since, on either branch. The
  diagnosis is structural, but a fix cannot be verified without a reproduction
  harness, which is why it is not attempted here. Nothing in this diff opens a
  socket or spawns a process.

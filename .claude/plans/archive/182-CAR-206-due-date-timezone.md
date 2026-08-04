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

## Second pass: deep review + the two deferred defects

Dawson directed that the deep review's findings and both previously-deferred
defects land in this PR. A Tier 2 agent review (7 discovery agents, 17 verifiers,
241 spot-checks) produced 17 candidates: 14 confirmed, 1 downgraded, 2 rejected.

### Fixed from the review

* **Snooze wrote an already-past timestamp** (four agents found it independently,
  the worst regression this PR introduced). The "is the due date ahead?" gate was
  changed from an instant to a calendar comparison, but the value written to
  `snoozed_until` stayed the raw midnight-UTC wire value. West of UTC that has
  already elapsed by late afternoon, so the snooze silently no-opped and the item
  came straight back while the UI reported success. Now writes
  `localMidnightIso(dueKey)`, which the calendar gate proves is still ahead.
* **MCP `due_at: ""` silently wiped a due date.** `normalizeDueAt` mapped the
  empty string to null. Pre-PR `""` reached PostgREST and failed with 22007, so
  nothing was lost — the PR turned a loud, harmless failure into silent erasure,
  contradicting its own docstring. `""` now throws, and the Zod schemas carry
  `.min(1)` so it is refused at validation first.
* **The timeZone-pin guard test was vacuous.** It probed with Pacific/Kiritimati
  (UTC+14); the instant under test is midnight UTC, so every eastward zone lands
  on the same date and the assertion passed even with the pin deleted outright.
  Now probes four zones west of UTC.
* **`dueDateKey` admitted non-dates.** A bare regex accepted `2026-02-30`, and
  `Date.UTC`'s legacy two-digit-year rule remapped years under 0100, so the
  formatter and the comparison helpers disagreed about the same key. Now
  round-trip validated. Writing the test for this found a second bug of my own:
  `shiftDateKey` did not zero-pad years to four digits.
* **The MCP write path had no tests at all** — not the throw, not the empty
  string, not the offset truncation. Seven cases added, including that the
  rejection reaches the agent through `handler()` as a tool error rather than an
  unhandled throw.
* **The MCP due-window comment overclaimed.** These windows key off the calendar
  date of the *process*, which is UTC on Vercel; the operator's own zone is not
  knowable there. The comment now says so instead of implying the surface is
  fully fixed.

### Fixed from the review (pre-existing, not introduced here)

* **`meetings.meeting_date` had the same defect and a data-corrupting round
  trip.** Every writer sends a naive local wall clock with no offset, so Postgres
  stores the typed digits as UTC. Five display sites rendered it through the
  viewer's zone (a meeting entered as Jan 5 2:00 PM showed as Jan 4 7:00 AM in
  Denver), and — worse — the two edit forms re-seeded themselves with *local*
  getters, so every open-and-save walked the meeting backward by one offset,
  compounding each time. Fixed display-side with `formatWallClock` /
  `wallClockParts`: no migration, and existing rows read correctly immediately.
  The alternative the reviewer floated (store real instants) needs a backfill
  that is unknowable for historical rows.
* **`bulk-import` wrote `due_at` unnormalized**, and the comment introduced by
  this PR asserted MCP was the only such path. Now uses `coerceDueDate` (the
  non-throwing variant, so one bad spreadsheet cell drops a due date rather than
  failing the import), and the false claim is gone.

### The two deferred defects, now fixed

Both needed a decision about what a "day" means. The decision, applied
uniformly: **every day comparison uses the evaluating environment's local
calendar on BOTH sides.** In the browser that is the user's real day; on the
server it is UTC, the best available. The bug was never the choice of basis, it
was the mismatch between the two sides of a comparison.

* **Streak.** `activeDays` bucketed activity by UTC date while
  `deriveNetworkingStreak` compared against a local midnight pushed back through
  `toISOString()` — which east of UTC names *yesterday*. Both sides now use
  `dateKeyOf`. The existing tests could not have caught this: the fixture built
  its day keys with the same expression the rule used, so the assertion was true
  by construction. Rewritten to build keys the way the fetch site does.
* **`days_overdue` / `daysSinceTouch` / on-track.** Six sites divided an elapsed
  millisecond gap between a local midnight and a raw instant. Reproduced on
  `main` under `TZ=Asia/Kolkata` as an off-by-one. All now use
  `daysBetweenDateKeys`. Three further elapsed-millisecond day counts in the same
  family (`page.tsx` last-contacted, `mcp/tools/contacts.ts`, `mcp/lib/dossier.ts`)
  were fixed with them.

### Rejected by verification, correctly

`get_contact_dossier` emitting a raw timestamp (untouched by this PR's diff) and
a claim that CONVENTIONS.md needs updating (its own standard says otherwise).

### Two tests I wrote that did not bite, and how they were caught

Falsification found both. The first streak zone test asserted a 3-day run stayed
3 across a list of zones — it passed against the old implementation too, because
a contiguous run is shift-invariant and cannot see a one-day offset. Replaced
with a set that has a hole at the boundary. The timeZone-pin test is the other,
above. Both are recorded in the test files themselves so the next person does not
repeat the reasoning.

## Verify

`npm run test` (2,812) under `TZ=` America/Denver, Pacific/Auckland, UTC,
Asia/Kolkata, Asia/Kathmandu and Pacific/Chatham; typecheck, lint,
`check:conventions`, `check:ui-events`, the coverage gate and `npm run build`.

## Still open, deliberately

`prod-drift-check-script.test.ts` has a TOCTOU race in its `freePort()` helper:
it binds a port, reads it, closes, and returns it, after which anything can claim
it before the script under test checks whether it is held. Observed failing once
in ~13 full-suite runs and not reproduced since on either branch. Not fixed here
because a fix cannot be verified without a reproduction harness, and shipping an
unverifiable change to an unrelated flaky test is worse than reporting it.
Nothing in this diff opens a socket or spawns a process.

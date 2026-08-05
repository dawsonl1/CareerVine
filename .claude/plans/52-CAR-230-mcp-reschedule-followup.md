# CAR-230 — MCP: reschedule the send time of an active follow-up sequence

## Goal

Change *when* the remaining steps of an active follow-up sequence fire, without touching
their approved copy, from MCP.

Immediate use: 26 active sequences whose first steps are spread 9:28 AM to 4:41 PM Mountain,
wanted in staggered morning batches (9:03, 9:08, 9:13, 9:18, 9:23, 9:28).

## Why the existing paths do not work

- `create_follow_up_sequence` (MCP) derives send time by inheriting the opening email's local
  time-of-day (`buildMcpFollowUpRows`, `careervine/src/mcp/tools/email.ts`). Cancel-and-recreate
  therefore reproduces the same scattered times. Not a workaround.
- `PUT /api/gmail/follow-ups/[id]` accepts an explicit `sendTime` but **deletes every unresolved
  message and rebuilds from caller-supplied `subject` + `bodyHtml`**. Retiming through it means
  resupplying reviewed outbound copy for what is a metadata change, and it needs a browser
  session, so MCP cannot reach it.

## Design

### Keep the day, change the clock

The new path derives each step's calendar date from its **existing `scheduled_send_at`** read in
the user's zone, not from `original_sent_at + send_after_days`.

This matters. `send_after_days` deliberately stores the *requested* delay, not the clamped one
(`follow-up-helpers.ts`, the comment above `send_after_days` in the returned row), so a step
that was clamped forward at creation has a stored date the naive formula does not reproduce.
Re-deriving would silently move such a step **backward** onto a date the user never saw.

### One authority for the timing invariants

The CAR-220 invariants (every instant strictly future, steps strictly increasing, whole-local-day
advances, calendar arithmetic across DST) currently live inline inside `buildFollowUpMessageRows`.
Duplicating them in a second writer is the failure mode this repo keeps paying for.

Extract them into a shared primitive in `careervine/src/lib/follow-up-helpers.ts`:

```ts
export function clampFollowUpInstants(
  steps: Array<{ localDate: { year: number; month: number; day: number }; hour: number; minute: number }>,
  timeZone: string,
  now?: Date,
): Date[]
```

Per step: start at `localDate` at `hour:minute` in `timeZone`; while `<= floor`, advance whole
local days (same bounded jump-then-guard shape as today, so DST cannot leave it an hour short);
then raise the floor. Both callers use it:

- `buildFollowUpMessageRows` computes `localDate` from `sentAt + sendAfterDays` (calendar-based,
  via the existing `zonedDateParts`) and delegates the clamping. **Pure refactor, no behavior
  change** — existing tests must stay green untouched.
- The reschedule path computes `localDate` from each row's existing `scheduled_send_at`.

### Write lives in the shared data layer

`rescheduleFollowUpSequenceCascade(client, userId, followUpId, sendTime, timeZone, now?)` goes in
`careervine/src/lib/data/emails.ts`, beside `cancelFollowUpSequenceCascade`, and MCP calls it
through a thin `src/mcp/lib/db.ts` wrapper — mirroring exactly how `cancelFollowUpSequence`
already works (conventions §d: queries live in `src/lib/data/`, MCP is a thin layer).

Behavior:

- Parent must be `status = active`, scoped to `userId`. Otherwise return false → MCP throws
  `No active follow-up sequence with id N`, matching the cancel tool's message shape.
- Only `UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES` rows move. A `sent` step is history; a `sending`
  step is mid-claim and must not be retimed under the send driver.
- Rows are ordered by `sequence_number` so the monotonic guard applies in sequence order, not
  arbitrary PostgREST order.
- Control-flow reads use `must()`. Service role bypasses RLS, so every query filters on
  `user_id` / joins through the owned parent (enforced by `mcp/__tests__/db-scoping.test.ts`).
- Returns the new instants so the tool can report what it did.

### MCP tool

`reschedule_follow_up(follow_up_id, send_time)` in `careervine/src/mcp/tools/email.ts`.

- `send_time`: `HH:MM`, **local to the user's resolved zone** (`resolveUserTimeZone`, no headers
  on the MCP path — same resolver the create path uses). Reuse the `/^\d{1,2}:\d{2}$/` shape from
  `api-schemas.ts` and range-guard H<24 / M<60, as `buildFollowUpMessageRows` already does.
- Returns each step's sequence number and its new instant, so a caller can verify rather than
  assume.

Deliberately **not** in scope: per-step times, changing `send_after_days`, moving a sequence to a
different date. One tool, one job. Batching across many sequences is the caller's business.

## Files

| File | Change |
| --- | --- |
| `careervine/src/lib/follow-up-helpers.ts` | extract `clampFollowUpInstants`; `buildFollowUpMessageRows` delegates to it |
| `careervine/src/lib/data/emails.ts` | add `rescheduleFollowUpSequenceCascade` |
| `careervine/src/mcp/lib/db.ts` | add `rescheduleFollowUpSequence` wrapper |
| `careervine/src/mcp/tools/email.ts` | register `reschedule_follow_up` |
| tests | below |

No migration. No new column. No schema change.

## Tests

- `clampFollowUpInstants`: a past local date advances by whole days, not to `now`; two steps that
  both clamp stay strictly increasing; a DST boundary inside the jump does not leave it an hour
  short; a future date passes through untouched.
- `buildFollowUpMessageRows`: existing suite must pass **unmodified** — that is the refactor's
  proof.
- `rescheduleFollowUpSequenceCascade`: retimes only unresolved rows; leaves `sent` alone; refuses
  a non-active parent; refuses another user's sequence; a requested time already past today lands
  on the next local day; preserves each row's calendar date when the time is still ahead.
- MCP tool: rejects malformed `send_time`; surfaces the not-found error verbatim.
- `db-scoping.test.ts` and `check:conventions` must stay green.

## Verification

From `careervine/`: `npm run test`, `npm run check:conventions`, `npm run test:integration`,
`npm run build`.

## Rollout

1. PR, CI green on all six required checks, wait for Dawson's go-ahead, merge (deploys).
2. Reconnect the MCP so the session picks up the new tool. **Open risk: the tool list is
   fetched at connection time, so a redeploy alone may not surface it — this may need a session
   reconnect before step 3 is possible.**
3. Retime the 26 sequences into six batches of 5 at 9:03 / 9:08 / 9:13 / 9:18 / 9:23 / 9:28
   Mountain, then verify with `list_scheduled`.

## Out of scope

Cancelling a sequence on reply at Gmail-sync time. Investigated under this ticket and declined:
reply cancellation is lazy by design and already correct at send time
(`api/cron/send-follow-ups/route.ts` checks the thread before every send), `/api/gmail/sync` is
manual-refresh-driven so it would not reliably help, and it would add a fourth writer to these
two tables.

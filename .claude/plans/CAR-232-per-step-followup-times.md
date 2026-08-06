# CAR-232 — Per-step send times for follow-up sequences over MCP

## Problem

Every step of a follow-up sequence fires at the same local time of day. You cannot say
"step 1 at 11:05, step 2 at 10:22, step 3 at 09:03". Two call sites flatten it, and both
are in the MCP layer.

## Key finding: no migration

The storage and the date math already support this.

- `email_follow_up_messages.scheduled_send_at` is a per-row `TIMESTAMPTZ`
  (`supabase/migrations/20260218060000_create_email_follow_ups.sql:30`).
- `buildFollowUpMessageRows` already calls `parseSendTime(m.sendTime)` **per message**
  (`careervine/src/lib/follow-up-helpers.ts:223-226`).

Only the MCP input schemas and the two places that collapse a single time onto every step
need to change. Nothing in the cron, the sender, the web modal, or the schema moves.

## Changes

### 1. Shared time validator (`careervine/src/mcp/tools/email.ts`)

`reschedule_follow_up` already has an inline `HH:MM` regex + 24-hour `refine`. Lift it to a
module-level `sendTimeSchema` and reuse it in both places rather than writing a second copy
that can drift.

### 2. Creation path

- `followUpStepShape` (`:136`) gains optional `send_at_time`.
- `buildMcpFollowUpRows` (`:211`) uses `step.send_at_time ?? anchorSendTime` per step. The
  outer `sendTime` const is renamed `anchorSendTime` so the fallback reads unambiguously.
- The `.describe()` copy on `follow_ups` (`:150`) and `messages` (`:168`) currently promises
  "Each goes out at the same time of day as the opening email." That becomes the documented
  default rather than a guarantee.

Omitting the field reproduces today's rows exactly, which is the backward-compat contract.

### 3. Reschedule path

`reschedule_follow_up` gains an optional `step_times: [{sequence_number, send_time}]`
alongside the existing `send_time`. Exactly one of the two must be supplied.

`rescheduleFollowUpSequence` (`careervine/src/mcp/lib/db.ts:857`) and
`rescheduleFollowUpSequenceCascade` (`careervine/src/lib/data/emails.ts:315`) widen their
`sendTime: string` parameter to `string | ReadonlyMap<number, string>`.

Resolution per step, inside the cascade:

1. A single string applies to every step (today's behavior).
2. A map applies its entry for that `sequence_number`.
3. A step absent from the map **keeps its current local clock**, read back with
   `zonedTimeOfDay`. It is not silently dragged to some other step's time.

Everything the cascade already guarantees is untouched: the date still comes from the row
rather than `send_after_days`, only `scheduled_send_at` is written, and `sending` rows stay
excluded.

## Risks

- **The strictly-increasing guard.** `clampFollowUpInstants` keeps steps in send order. A
  sequence with decreasing times of day (11:05 → 10:22 → 09:03) is still strictly increasing
  in absolute terms because the dates differ, but that is exactly the kind of assumption that
  should be a test, not a belief. If two steps ever share a date with decreasing times, the
  clamp will push the second one out, and the test should pin whichever behavior we want.
- **Naming.** `send_at_time` on a step vs `send_time` on the reschedule tool. Deliberate:
  they mean different things (one is part of a step definition, one is a command argument),
  and reusing the name would imply they are interchangeable.

## Tests

New cases in the MCP tool and follow-up helper suites:

1. Three steps with distinct `send_at_time` land on three different local clock times, on the
   dates `send_after_days` implies.
2. Mixed: some steps carry the field, some do not; the bare ones inherit the anchor.
3. No step carries it: rows are byte-identical to the current implementation.
4. Per-step reschedule sets different times on different remaining steps.
5. A `sequence_number` absent from the reschedule map keeps its own existing clock.
6. Decreasing times across increasing dates survive the strictly-increasing guard.
7. A step crossing a DST boundary keeps its requested wall clock.

## Verification

From `careervine/`: `npm run test`, `npm run check:conventions`, `npm run build`.
Integration tier is untouched (no schema change), so `test:integration` is a regression check
rather than a target.

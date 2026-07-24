# CAR-179: Stop post-send failures from releasing the claim (duplicate-send fix)

## Problem

In `processScheduledEmails` (`careervine/src/lib/gmail.ts`), the catch block
releases the claim (`sending` → `pending`) on **any** throw inside the try. The
mark-sent write to `scheduled_emails` and the follow-up-linking write to
`email_follow_ups` both sit after the Gmail send inside that same try. If either
rejects at the transport layer (network failure to Supabase — PostgREST errors
surface as values, but fetch-level failures throw), the row returns to
`pending` after the email was already delivered, and the next 15-minute cron
tick re-sends it. Duplicate outreach to a professional contact is exactly the
failure CAR-134's atomic claim was built to prevent.

The comment at the catch asserts throws "almost certainly precede Gmail
accepting the message" — true for the internals of `sendTrackedEmail`, false
for the two awaited Supabase writes in the caller. Invariant asserted in a
comment, not enforced by code (the audit's root-cause theme #4).

The sibling crash path already handles this correctly: a process killed after
the send leaves the row in `sending`, and the sweeper in
`scheduled-email-cron.ts` flags stale `sending` rows as `failed` (with a UI
Retry action) precisely because re-queueing could double-send. The catch
undoes that protection for the in-process failure case.

## Fix

Track whether the send completed, and make the release conditional on it:

1. In the per-email loop, add `let delivered = false;` set to `true`
   immediately after `send()` resolves.
2. In the catch: if `delivered`, do **not** call `releaseClaim()` — log the
   bookkeeping failure and leave the row in `sending` for the stale-claim
   sweeper to flag `failed` (same terminal path as the killed-process case).
   Still count it in `errors`. If not delivered, release as today.
3. Rewrite the load-bearing comment to state the actual invariant: once
   `send()` has returned, the claim is never released; a failed mark-sent
   write is a bookkeeping problem to reconcile, never a reason to re-deliver.

Unchanged (confirmed correct): `SendPolicyError` handling releases the claim
before any delivery (429 stops the batch, 422 skips the row) — no delivery
occurred there, so retrying is safe.

## Tests (`careervine/src/__tests__/scheduled-email-process.test.ts`)

Extend the existing in-memory harness with per-table update-failure injection,
then add:

* **Post-send mark-sent failure**: `send` succeeds, the `scheduled_emails`
  mark-sent update rejects → row stays `sending` (not `pending`), result
  counts 1 error, and a second `processScheduledEmails` pass performs **no
  second send** (the claim filter skips `sending` rows).
* **Post-send follow-up-write failure**: same shape for the
  `email_follow_ups` update — the row must not return to `pending`.
  (Note: with the mark-sent write already landed the row is `sent`, which is
  equally safe; the assertion is "never `pending`, never re-sent".)
* **Pre-send failure regression**: the existing "unexpected send failure
  releases the claim" test keeps passing — pre-send throws still retry.

## Verification

`npm run test` from `careervine/` green, then PR with `(CAR-179)` title.
No schema change, no docs/copy impact (internal reliability fix; user-visible
behavior only in the failure case, where the docs make no claims).

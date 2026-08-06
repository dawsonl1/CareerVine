# CAR-233 — Cancel follow-up sequences as soon as a mailbox sync sees the reply

## Problem

Reply-cancellation is **send-time only**. `send-follow-ups/route.ts:384-448` does one
`threads.get` per due sequence, and cancels if any message on the thread is from
someone other than the user. Until a step actually comes due, a sequence whose
contact already wrote back stays `active` and keeps rendering as scheduled.

The app already knows about the reply well before that. `/api/gmail/sync` writes the
inbound row into `email_messages` in two places, and both then stop short:

- `syncAllContactEmails` → per-contact insert (`gmail.ts:370-426`): activates the
  contact, fires `reply_received`, never touches `email_follow_ups`.
- `syncThreadReplies` (`gmail.ts:1476-1574`, CAR-227): same, for replies from an
  address the contact record doesn't carry.

The one thing downstream of sync that *does* cancel sequences is `detectBounces`
(`gmail.ts:1778-1787`) — and only for NDRs. A reply cancels nothing.

## Goal

When CareerVine observes an inbound reply on a thread, cancel that thread's active
follow-up sequences immediately. **Keep the send-time check** — it remains the safety
net for a reply that has not been synced yet (and the only mechanism free-tier users
without mailbox scope ever had).

**Hard constraint: no page-load cost.** The cancel rides the sync write path, which
already pays for a Gmail round trip, and adds zero Gmail API calls and zero per-page
work.

## Why the sync path is the right hook

There is no cron that reads the inbox — `/api/gmail/sync` runs only when the user
presses Refresh (`inbox-top-bar.tsx:70`, looped by `gmail-sync-client.ts:25-52`).
So "the webapp sees a reply" happens at exactly one instant, and it is already an
expensive, user-initiated, off-the-critical-path operation.

Everything on the load path stays untouched: `/api/gmail/inbox` (DB-only by design),
the global unread-count poll (CAR-229's hot path), and the dashboard loaders. No
speculative "did anyone reply?" check is added anywhere a page render can wait on it.

The added cost inside sync is **3 DB round trips per batch that actually produced a
new inbound row**, and zero otherwise. No Gmail call: the reply is already in hand.

## Design

### 1. One shared helper — `cancelFollowUpsForRepliedThreads`

New export in `careervine/src/lib/follow-up-helpers.ts`, beside the existing
`cancelFollowUpsForScheduledEmail`:

```ts
cancelFollowUpsForRepliedThreads(service, userId, threadIds, now?) => Promise<number>
```

- Dedupes/filters `threadIds`; returns `0` immediately on an empty set (the common case).
- Reads `email_follow_ups` where `user_id` + `thread_id IN (...)` + `status = 'active'`.
- **Parent-first**, matching `cancelFollowUpSequenceCascade`'s documented ordering:
  parents `active → cancelled_reply` (count-based CAS, rule 17), then unresolved
  children → `cancelled`.
- Children filtered to `UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES` (pending /
  awaiting_review / expired). **`sending` is deliberately excluded** — a claim a send
  driver holds must never be stomped mid-flight; the cron's stale-claim sweep owns it.
- Batched: 1 select + 2 updates regardless of how many threads or sequences.
- **Does not activate the contact.** Every caller already does that on its own terms
  (by contact id in sync, by address in the cron and the manual path), and folding it
  in would double-write.

### 2. Call it from every place a reply becomes known

| Call site | Change |
| --- | --- |
| `gmail.ts` `syncAllContactEmails` (~L384) | `threadIds` is already computed at L401-402 for analytics. Cancel from the same set, ahead of the analytics block so a flaky attribution read can't skip it. Add `from_address` to the insert's `.select()` and drop NDR senders. |
| `gmail.ts` `syncThreadReplies` (~L1517) | Accumulate replied thread ids in a `Set` as inbound rows land, one helper call before `return`. (Bounce senders are already skipped at L1470.) |
| `follow-up-reply.ts` `recordThreadReply` (L29-49) | Replace the hand-rolled per-sequence loop with the helper. Behavior identical; one implementation instead of two. |
| `send-follow-ups/route.ts` (L433-448) | Replace the inline pair of updates with the helper, keyed on the sequence's `threadId`. `activateContactByEmail` and the `cancelled` counter stay. |

That last one is the point of doing this as a shared helper rather than a fourth
inline copy: reply-cancellation currently exists three times in three files with
three chances to drift.

### 3. Error posture

The sync-side calls are **error-tolerated** (log, don't throw), matching the contact
activation and analytics writes beside them. A failed cancel is not a lost feature:
the send-time check still catches it before anything goes out. Failing the whole sync
request would report a completed mail sync as broken over a nag we would have caught
anyway. The cron-side call keeps the cron's existing posture.

### 4. NDRs

A bounce is not a reply. `syncThreadReplies` already refuses to ingest NDR senders as
inbound; the per-contact path gets the same `isBounceSenderAddress` guard so a
delivery failure can never land as `cancelled_reply` (it belongs to `detectBounces`
and `cancelled_bounce`).

## Out of scope, deliberately

`scheduled_emails` are **not** reply-cancelled. They have never had a send-time reply
check either (`processScheduledEmails`, `gmail.ts:1169`, makes no such call), so
cancelling them here would introduce a product behavior with no send-time counterpart
— and a user-scheduled reply-in-thread email is deliberate content, not an automated
nudge. Worth a separate decision, not a silent side effect of this change.

No migration: `cancelled_reply` is already in `FollowUpStatus` and already in the
table's CHECK (`20260726010000_car207_...`).

## Verification

- **Unit** — new `cancel-followups-on-reply.test.ts`: cancels active sequences on a
  replied thread; leaves other users' and other threads' sequences alone; leaves
  `sending` children untouched; clears `awaiting_review` and `expired` children;
  no-ops on an empty/all-resolved set.
- **Sync integration** — extend `gmail-sync-contact.test.ts` (the `createFakeSyncDb` +
  `createFakeGmail` harness runs the real loop): an inbound message on a thread with
  an active sequence cancels it; an outbound-only sync does not; an NDR sender does not.
- **Regression** — `send-follow-ups-*.test.ts` and `follow-up-*.test.ts` must stay
  green across the cron refactor.
- `npm run test`, `npm run test:integration`, `npm run check:conventions`, `npm run build`.

## Copy to update in the same PR

- `careervine/public/docs/index.html:725` ("Stops the moment they reply") — currently
  promises only the per-tick check; it now also stops as soon as a mailbox sync sees
  the reply.
- `careervine/README.md:39` — same correction, product voice.

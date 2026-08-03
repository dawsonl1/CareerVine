# CAR-214 — Queue follow-ups alongside the opening email over MCP, and thread them into the original conversation

## Problem

Two separate things are broken, and they compound.

**You cannot queue follow-ups with a not-yet-sent email over MCP.** `create_follow_up_sequence` anchors only to an already-synced outbound message, via `findOriginalOutbound` ([mcp/lib/db.ts:810](../../careervine/src/mcp/lib/db.ts)). No sent message, no anchor, hard throw: *"Provide thread_id or original_message_id."* So an assistant scheduling an intro has to defer the follow-ups to a later session and hope it happens.

**The follow-ups that do send are not threaded for the recipient.** Both send sites pass the Gmail API message id where the RFC 822 Message-ID belongs.

## The threading bug, in detail

`sendEmail` returns `res.data.id` ([gmail-send-core.ts:150](../../careervine/src/lib/gmail-send-core.ts)) — the **Gmail API id**, e.g. `19f6701a3d3b3935`. That is stored as `email_follow_ups.original_gmail_message_id`, both by the interactive path and by the scheduled-send back-fill ([gmail.ts:1273](../../careervine/src/lib/gmail.ts)).

Both follow-up send sites then hand that value straight to the threading headers:

- [cron/send-follow-ups/route.ts:401-402](../../careervine/src/app/api/cron/send-follow-ups/route.ts)
- [gmail/follow-ups/confirm/route.ts:126-127](../../careervine/src/app/api/gmail/follow-ups/confirm/route.ts)

and `buildMimeMessage` writes it verbatim ([gmail-send-core.ts:121-122](../../careervine/src/lib/gmail-send-core.ts)):

```
In-Reply-To: 19f6701a3d3b3935
References: 19f6701a3d3b3935
```

That is not a valid `msg-id` — no angle brackets, no domain — and it matches no Message-ID anywhere. **The recipient's mail client cannot thread it**, so a follow-up lands as a standalone message in their inbox rather than a reply in the same conversation.

It threads fine in *our* Gmail because `threadId` is passed to `messages.send` and Gmail groups server-side. That is exactly why this has gone unnoticed: it looks correct from the sender's side.

The codebase already knows the difference. [types.ts:171-175](../../careervine/src/lib/types.ts) documents the RFC id as "carried for threading headers (In-Reply-To / References) only", and the MCP compose path resolves it properly in `resolveReplyHeaders` ([mcp/tools/email.ts:75-89](../../careervine/src/mcp/tools/email.ts)). Only the follow-up senders skipped it.

`email_messages` caches no RFC Message-ID column, so the value must be resolved from Gmail.

## What already works (do not rebuild)

The pre-send follow-up capability is fully built everywhere except MCP:

| Piece | Where |
| --- | --- |
| `thread_id` / `original_gmail_message_id` nullable "for scheduled sends" | `20260325000000_intro_email_flow.sql:8-10` |
| `email_follow_ups.scheduled_email_id` FK | `20260218070000_create_scheduled_emails.sql:30-31` |
| Back-fill of both ids when the parent sends | `gmail.ts:1269-1278` |
| Dormancy until then (`thread_id is not null` filter) | `cron/send-follow-ups/route.ts:171` |
| Teardown when the parent is cancelled | `cancelFollowUpsForScheduledEmail` |
| Web equivalent: schedule + follow-ups in one action | `compose-email-modal.tsx:657` → `/api/email-follow-ups` |

The web route writes `thread_id`/`original_gmail_message_id` as **NULL** and relies on the dormancy filter. The Scheduled-tab attach button instead writes a `pending_scheduled_<id>` placeholder ([scheduled-tab.tsx:83](../../careervine/src/components/email/inbox/scheduled-tab.tsx)), which defeats that filter — the row enters the due query and is saved only by `threads.get` 404-ing into a `catch { continue }`. Benign today because steps are ≥1 day out, but it is the wrong convention. **Use NULL.**

## Plan

### 1. Shared threading resolver (new)

`careervine/src/lib/follow-up-threading.ts`:

```ts
resolveFollowUpThreadHeaders(userId, threadId, opts?: { thread?: gmail_v1.Schema$Thread })
  -> { inReplyTo?: string; references?: string }
```

- Reads `Message-ID` from the thread's messages, in order.
- `inReplyTo` = the last message's Message-ID (thread under the newest turn).
- `references` = space-joined chain of every Message-ID (RFC 5322 §3.6.4).
- **On failure or empty result, omit both headers.** A missing header is strictly better than a malformed one: Gmail's `threadId` still groups it for the sender, and a bogus `In-Reply-To` can hurt deliverability.

Call sites:
- **Cron** already fetches the thread for reply detection ([route.ts:314](../../careervine/src/app/api/cron/send-follow-ups/route.ts)). Add `"Message-ID"` to its `metadataHeaders` and pass the thread in → **zero extra API calls**.
- **Confirm route** has no thread in hand (`replied` comes from the client) → it does its own `threads.get`.

This is self-healing: every existing sequence starts threading correctly on its next send, with no backfill.

### 2. Queue follow-ups with the opening email (MCP)

- `schedule_email` gains optional `follow_ups[]` (`subject`, `body`, `send_after_days`, optional `send_time`). One call queues the email and the sequence.
- `create_follow_up_sequence` gains `scheduled_email_id` as a third anchor.
- Shared path writes: ids NULL, `scheduled_email_id` set, `contact_id` set, timing based on `scheduled_send_at`.
- Reject a `scheduled_email_id` that is not this user's, or not `pending`.

### 3. Fix the 3:00 AM local send time

`buildFollowUpMessageRows` hard-defaults to `setUTCHours(9,0,0,0)` — 09:00 **UTC**. The web route compensates with a browser-supplied `timezoneOffsetMinutes`; MCP has no browser and never compensates, so a 9:00 Mountain opener yields 3:00 AM Mountain follow-ups.

Default MCP follow-ups to **the parent send's time-of-day** (pass it through as `sendTime`), so a 9:00 Mountain opener produces 9:00 Mountain follow-ups. Explicit `send_time` overrides.

### 4. Set `contact_id` on MCP sequences

`insertFollowUpSequence` ([mcp/lib/db.ts:829](../../careervine/src/mcp/lib/db.ts)) omits it, so MCP-created sequences never show in the contact page's follow-up list, which filters on `contact_id`. Thread it through.

### 5. The three parked sequences

Sequences 3/4/5 (user `63198da1`) are `awaiting_review`, parked July 22-23, expiring Aug 5-6. That connection now reads `premium_enabled: true, automatic_features_enabled: true, modify_scope_granted: true` → resolves to `followups:auto`, which should have auto-sent.

Working hypothesis: the tier flags were flipped to premium **after** the rows parked, and nothing re-evaluates a parked row's tier. (The confirming `updated_at` read was blocked by the sandbox classifier; confirm before fixing.)

If confirmed, the durable fix is for the cron to un-park `awaiting_review` rows belonging to a user who now holds `followups:auto` and whose window has not expired, returning them to `pending`. Those three are demo sends ("This is a test", "Showing gmail.send") — confirm with Dawson whether to send or cancel them rather than auto-firing 12-day-old test emails at real people.

## Verification

- `npm run test`, `npm run build`, `npm run check:conventions` from `careervine/`.
- New unit tests: threading resolver (chain building, fallback-to-omit), the MCP `follow_ups[]` path (NULL ids, `scheduled_email_id`, `contact_id`, timing off `scheduled_send_at`), and the tier un-park.
- Falsification pass on every new test (rule: patch the fix out, confirm the test goes red).
- **End-to-end threading proof required**: send a real message, attach a sequence, force a send, and read the raw outgoing headers back from Gmail to confirm `In-Reply-To` carries a real `<...@mail.gmail.com>`. The whole point is recipient-side behavior, which no unit test observes.

## Docs

Follow-up cadence/behavior copy: `careervine/public/docs/index.html`, `careervine-mcp/README.md` (documents the tool surface), and `careervine/README.md`. No cadence change, so `cron-schedules-registry.test.ts` is unaffected.

## Migrations

None expected. The resolver reads from Gmail rather than adding a cached Message-ID column, so items 1-4 are code-only.

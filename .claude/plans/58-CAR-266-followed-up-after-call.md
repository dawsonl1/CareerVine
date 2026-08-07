# CAR-266: Recognize a follow-up already sent after a call

## Problem

Brevium's company card says **"Follow up with Lance after your call"** even though the
thank-you email went out the day after the call. `call_done` is sticky, and the
`pastConversationAction` rung in `company-next-action.ts` reads only the conversation —
never what happened after it. Same family as CAR-253 (sticky "write back"), one rung up.

## Approach

All the evidence is already flowing into `deriveNextAction`:

- `lastOutreachAt` — the lead's latest outbound email or logged interaction
  (`lead_detail.last_outreach_at`, computed in `getContactStages` as `tallies.contacted.at`).
- `conversationAt` — the timestamp of the conversation the pill describes
  (`traction_detail.at`; for `call_done` this is the winning lead's latest past conversation).
- `replyThread` — the lead's per-thread reply state (CAR-253).

### 1. Data layer (`company-queries.ts`)

Extend `ReplyThreadState` with one field:

- `lastUnansweredReplyAt: string | null` — the latest inbound reply on threads still
  awaiting our response (null when `awaitingOurReply` is false). Computed in the existing
  bucket loop from the already-filtered `theirs` timestamps of awaiting buckets. This is
  what lets the ladder tell "they replied *after the call*" from "an old scheduling reply
  we never answered" — without it, promoting on `awaitingOurReply` alone would resurrect
  pre-call nags that the call itself already answered.

### 2. Ladder (`company-next-action.ts`)

Rework the `traction === "call_done"` rung into three ordered checks:

1. **Unanswered reply postdating the conversation** (`replyThread.awaitingOurReply` and
   `lastUnansweredReplyAt > conversationAt`) → the existing "Lance replied, write back"
   line (MailOpen, active, rank 84), extracted into a shared helper so this and the
   `replied` rung cannot drift. Applies to every conversation kind — an unanswered
   post-conversation reply is actionable no matter what the conversation was.
2. **Follow-up already sent** (`lastOutreachAt > conversationAt`, both non-null), for the
   three prompt kinds only (call / career-fair / networking) → muted statement
   **"You followed up with Lance yesterday"** (MailCheck, rank 60 — above the answered
   email thread at 58, below applied at 62). Time clause from `formatTimeAgo(lastOutreachAt)`
   (the follow-up's date, not the call's); drops the clause when unusable rather than
   inventing one. Text/Other already render statements, not prompts (CAR-257) — untouched.
3. **Otherwise** → the existing `pastConversationAction` prompt.

Strict `>` on both comparisons: a call double-logged as an interaction at the same
timestamp must not read as a follow-up.

Accepted fuzz (documented in code): hand-logged `meeting_date` is a wall clock stored as
UTC (CAR-206), so a same-day *pre*-call email can read as post-call for US timezones —
cost is retiring the prompt a few hours early. Google-synced events use real timestamptz.

### 3. Tests

- `company-next-action.test.ts`: new describe covering — follow-up after call flips to the
  muted statement (text, tone, icon, rank ordering vs 58/62); earlier/equal/missing
  timestamps keep the prompt; career-fair and networking variants; text/other unaffected;
  no-lead and future-date fallbacks; reply-promotion fires only when the unanswered reply
  postdates the conversation (with and without a follow-up also sent); pre-call unanswered
  reply does NOT promote.
- Data-layer coverage for `lastUnansweredReplyAt` wherever `getContactStages`' reply-thread
  state is currently pinned; update existing `ReplyThreadState` fixture literals.

## Verification

`npm run test`, `npm run check:conventions`, `npm run test:integration` from `careervine/`,
then build. No schema changes, no docs-page copy quoting this pill (verify with a grep).

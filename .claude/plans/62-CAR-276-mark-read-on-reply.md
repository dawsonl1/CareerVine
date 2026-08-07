# CAR-276 — Replying to a thread marks it read

## The complaint

A thread Dawson has already answered keeps counting toward the nav unread badge and
keeps rendering bold in the Inbox, because he never went back and opened the message
he already dealt with.

## Why it happens

`is_read` flips true in exactly one place: `markMessageAsRead` (`careervine/src/lib/gmail.ts`),
reached only from the two body-expand sites (`inbox-shell.tsx`, `use-email-body.ts`).
Nothing else ever marks an existing row read.

`sendTrackedEmail()` writes its own outbound row with `is_read: true` and never touches
the inbound rows on the thread it is answering. And the Gmail sync deliberately refuses
to overwrite `is_read` on an existing row ("Never overwrite is_read, is_trashed, or
is_hidden"), so a thread cleared on Gmail's side stays stale in CareerVine forever.

Two user-visible cases:

1. **Replied from CareerVine** (composer, MCP `send_email`, scheduled send, follow-up
   cron, follow-up confirm). Outbound row lands, inbound stays unread.
2. **Replied from Gmail or the phone.** Gmail clears UNREAD; CareerVine keeps `false`.
   Ordering matters here: the inbound was ingested *while still unread*, so the row was
   written `false` and the later reply never revisits it.

## The invariant

> An inbound message is read if you sent an outbound message on the same thread at a
> later time.

Monotonic: false to true only, never the reverse. That is what keeps it compatible with
the existing user-owned-`is_read` guard, whose whole purpose is stopping Gmail's label
state from flipping a locally-read message *back* to unread. This change never does that,
so the guard and its test (`gmail-sync-contact.test.ts`) stay exactly as they are.

Deriving the cutoff from the thread's own latest outbound row, rather than passing a
timestamp in, means both call sites share one rule with no parameters about time.

## Shape

**New `careervine/src/lib/email-read.ts`** — `reconcileThreadReadState(service, userId, threadIds, opts)`:

1. Read unread inbound rows on those threads.
2. Read outbound rows on those threads, keep the latest `date` per thread.
3. Mark every unread inbound whose `date` precedes its thread's latest outbound.
4. When `syncGmail`, remove the UNREAD label per message, best-effort, after the DB write
   — the same DB-first ordering and rationale as `markMessageAsRead`.

Lives in its own module rather than in `gmail.ts`, because `gmail.ts` already imports
`sendTrackedEmail` from `email-send.ts`; putting it there and calling it from the send
path would close an import cycle. It depends only on `gmail-send-core.ts` for the client.

**Call site 1 — `sendTrackedEmail()`** (`careervine/src/lib/email-send.ts`), after the sent-message
cache write, with `syncGmail: true`. That one choke point covers every outbound path.
Error-tolerated: the mail is already sent, so a failed read-reconcile must not turn a
successful send into an error.

**Call site 2 — the two sync ingest paths** (`syncEmailsForContact`, `syncThreadReplies`),
keyed on threads where the pass ingested an **outbound** message. That is precisely the new
information: "you replied on this thread from somewhere else." DB-only, no `syncGmail` —
in that scenario Gmail already cleared UNREAD itself, so the call would be a no-op round trip.

**Backfill migration** — applies the same invariant once to existing rows, so threads that
are already stuck clear immediately instead of waiting to be re-synced. Sets `is_read` true
only; nothing is ever set back to false.

## Deliberate edges

- **Null `date`.** A row whose Date header was missing or unparseable cannot be proven to
  predate the reply, so it stays unread. Failing toward "still unread" is the safe direction.
- **Automated follow-ups.** A follow-up firing on a thread that has an unread inbound is
  near-impossible, since any inbound cancels the sequence (`cancelFollowUpsForRepliedThreads`,
  and the send cron's own `threads.get` check). Left uniform rather than special-cased.
- **Free tier.** No capability check needed: unread inbound rows only exist behind
  `mailbox:read`, which free connections do not hold, so the query returns nothing and the
  Gmail call is never reached. Data-gated, not tier-gated.
- **Messages arriving after the reply** keep their unread state — the cutoff is one-directional.

## Verification

- Unit: the helper (marks only what predates the reply, leaves later inbound alone, null
  dates untouched, never writes false, Gmail failure does not undo the DB write), plus both
  call sites.
- Falsify every new test by breaking the code it covers before keeping it.
- E2E: replying leaves the thread `data-unread="false"` and it survives a reload.
- Suite, `check:conventions`, integration tier, build.

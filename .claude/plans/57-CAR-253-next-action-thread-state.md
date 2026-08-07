# CAR-253 — Date the "waiting" line, and stop demanding a write-back on a thread you already answered

Two lines on the /companies next-action pill.

## 1. "Waiting on Julian. Follow up if it's been a while" → "Waiting on Julian. You reached out 3 days ago"

"If it's been a while" makes the reader go find out how long it has been. The
number is already in the database. Say it.

## 2. "Samuel replied, write back" fires forever

The rung tests `traction === "replied"` and nothing else, and that stage is
sticky: once a contact has ever replied, the card demands a write-back for the
rest of time, including on threads where the last word was ours.

The rule, verbatim from Dawson: say "write back" only when **we have sent
nothing after their first reply on that thread**. If we answered at all, even if
they then replied again, the line becomes
`You had an email thread with Samuel (2 days ago)`.

That "already answered" state is *the ball is in their court* — the same posture
as `contacted` — so it also drops down the ladder rather than keeping the
live-inbound rank of 84.

---

## What the data layer has to learn

`getContactStages` (careervine/src/lib/company-queries.ts) already reads every
email linked to a contact, both directions, with dates. It does **not** group by
thread, and "did we write back" is a per-thread question. One extra column on an
existing select, no new query:

- select `thread_id` (and the junction's own `email_message_id`, as the bucket
  key for the rare message with no thread) on the email leg;
- bucket each contact's messages by thread: latest outbound, their reply dates,
  latest message either direction;
- per contact, `replyThread = { awaitingOurReply, lastMessageAt }`:
  - `awaitingOurReply` — **any** thread where they replied and no outbound of
    ours is dated after their FIRST reply there. Any, not all: two threads with
    one unanswered still means write back.
  - `lastMessageAt` — latest message across those threads, either direction,
    which is what "(2 days ago)" counts from.
  - `null` when no real reply backs the stage (a `stage_override`), which keeps
    today's copy for a state with no evidence behind it.

## What the company row has to carry

The pill names the **lead**, so it must be dated by the lead's own history, not
by the company-wide aggregate `traction_detail` already carries. New enrichment
field `lead_detail: { last_outreach_at, reply } | null`.

Adding a required member to `CompanyEnrichment` is deliberate — it is the type
that means "the who-you-know pass computed this", so an optional field there
would be the exact lie the `enrich` option exists to prevent. Test fixtures
typed as `CompanySummary` get updated.

**Lead tie-break.** With two current contacts at `replied`, `best` takes
whichever comes first. If that one is answered and the other is not, the new copy
would bury a real unanswered reply behind "You had an email thread". So on a rank
tie at `replied`, prefer the contact still awaiting our reply.

## Ladder (careervine/src/lib/company-next-action.ts)

| rung | rank | text |
| --- | --- | --- |
| `replied` + awaiting us | 84 (unchanged) | `Samuel replied, write back` |
| … | | |
| `replied`, already answered | **58** (new, muted) | `You had an email thread with Samuel (2 days ago)` |
| `contacted` | 56 | `Waiting on Julian. You reached out 3 days ago` |

58 sits below `applied` (62) and above `contacted` (56): warmer than a cold
outreach, colder than an application that wants a referral. Code order follows
rank order, so a mid-range deadline (70) still outranks both.

Unknown/undated degrades to today's copy rather than inventing a clause:
no `replyThread` → "write back"; no date → "Follow up if it's been a while".

`formatTimeAgo` gets added next to `formatRelativeTime` in
careervine/src/lib/relative-time.ts — same ladder, but a future timestamp (a
malformed `Date:` header) returns null instead of "You reached out in 3 days".

## Tests

- `relative-time` — past-only variant, including the future-timestamp drop.
- `company-next-action` — both new lines, the fallbacks, and that 84 > 58 > 56.
- `contact-stages-reply-thread` (new) — drives the real `getContactStages`
  through the recording client: unanswered reply, answered reply, Dawson's
  they-replied-again case, per-thread isolation, `stage_override` with no mail.
- `company-traction-chip` — the lead tie-break at a company with two repliers.
- `company-card-traction-chip` — the rendered pill.

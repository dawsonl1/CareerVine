# CareerVine web app

The Next.js app: UI, API routes, the hosted MCP server, and the cron workers.
For what the product is and why, see the [root README](../README.md). For how to
write code that fits the codebase, see [CONVENTIONS.md](./CONVENTIONS.md).

## Development

```bash
npm ci
npm run dev          # http://localhost:3000
```

`.env.local` holds the Supabase URL and keys plus any third-party keys you need.
`src/lib/supabase/config.ts` selects local or production values from the
environment, so the app builds without it but cannot reach a database.

Before pushing, run what CI runs:

```bash
npm run test         # vitest
npx tsc --noEmit     # typecheck
npm run lint         # eslint, zero warnings allowed
npm run check:ui-events
npm run check:conventions
npx next build
```

Migrations live in `../supabase/migrations` and are applied with `supabase db push`
from the repo root, never as hand-written SQL against production.

## Background automations

CareerVine runs background work through QStash so outreach keeps moving even when
the app is closed. Every schedule is declared in `scripts/qstash-schedules.mjs`,
which is the only place a cadence is defined; `node scripts/qstash-schedules.mjs list`
reports drift between what is declared and what is live. Cron routes verify the
QStash signature before anything runs, then wrap the job in an error guard.

- Follow-up sequence steps go out within about a minute of when they come due.
- Scheduled emails are sent within about a minute of the time you picked.
- Both run on their own schedule with an hourly safety net behind them, so a
  delivery is never lost, only occasionally a little later than usual.
- Each scheduled-email run reports delivery lag and throughput health, so capacity
  risks are visible before sends fall behind.
- On free Outreach, every pending and waiting follow-up step is visible with
  subject and date, editable before send, with confirm-to-send still applying when due.
- Follow-ups can be queued in the same breath as the email that starts the
  conversation, before it has sent. They wait for it to go out, land as replies
  on its thread, and cancel themselves the moment the contact writes back.
- Bundle sync jobs fan out on publish with a daily safety-net sweep.

This keeps delivery and data freshness reliable without requiring users to keep a
tab open.

## Company intelligence workflow

Every company page is a recruiting command center: your full contact roster on one
side, a living pipeline on the other.

- Track each employer through a visual pipeline (Researching, Active outreach,
  Applied, Interviewing, Closed) with the details that matter at each step:
  programs you're considering, research notes, every application you've submitted
  (with your actual resume and cover letter PDFs attached), and interview rounds.
- Target the whole company, a single office, or both. "Applied to Capital One
  generally" and "actively networking into the New York office" are separate
  pipelines with their own status and notes, switchable from one location dropdown.
- Applied more than once? Cycles keep each application season separate, so last
  year's run doesn't muddy this year's.
- The pipeline moves itself when it should: the moment someone who works at a
  company writes back, that company steps from Researching to Active outreach on
  its own. Only their current employer moves, and a company already at Applied or
  later is never dragged backwards by a stray reply on an old thread.
- Everything saves as you type, with no save buttons, and your pipeline stage flows
  straight into the Companies dashboard so priorities stay honest.
- The roster leads with the people who actually work there. Everyone who has moved
  on is folded into a collapsed "Former employees" group, so a company with years of
  scraped history still opens on the contacts you can reach inside it. Searching the
  roster still finds the people who left, without a click.
- Each person's card says what actually happened, not a generic status: a logged
  text exchange reads "Texted", a career fair reads "Career fair", and "Call done"
  is reserved for conversations that really were calls. Someone you have both
  called and texted wears one chip for each. The card also links straight to their
  LinkedIn profile, alongside their email, location, and current employer.
- Email a prospect in one click (with bounced and pattern-guessed addresses clearly
  flagged), promote bench contacts into outreach, and manage office locations
  without leaving the page.
- When an address stops accepting mail, you find out the same day. CareerVine reads
  delivery failures back on its own, cancels the follow-ups and scheduled emails
  still queued to that address, emails you what happened, and marks the address on
  the contact so you can fix it. A message that is merely delayed is left alone, so
  a good address is never retired by mistake.

### Find the right company instantly

As your target list grows, the Companies page keeps it navigable with instant
search and stackable filters:

- Search as you type across company names and program names. Results update
  instantly, no page reloads.
- Narrow the list by target status (researching through closed), outreach traction,
  office location, who you know inside, and whether anyone there went to your school.
- The page shows every company you target plus every company you already know
  someone at, so a target menu separates the two. "Not a target" is the shortlist
  worth reading before you pick your next one: places you have a way in and have not
  claimed yet.
- The location menu groups cities under their state, so you can take all of Utah in
  one click or pick Lehi and Boston individually, and type to jump straight to a
  city. Companies with no office on file are their own option, so they stay
  reachable instead of disappearing.
- Who you know inside is one menu, not two competing ones: pick "works there now",
  "worked there before", "no contacts yet", or any combination. Companies where your
  only connection has moved on are one click away, and so is the pair that means
  "anyone at all".
- The target, traction, location, contacts, and alumni menus each take several
  answers at once, so "Lehi or Boston" and "Replied or Call done" are single filters
  rather than two separate views.
- Filters combine, so "applied companies in Utah where I have no contacts yet" is
  two clicks, and a live count shows how much of your list matches.
- Filtering by location changes what each company card reports, not just which
  companies appear. Ask for Lehi and a card counts the people you know at the Lehi
  office, and says how many of your contacts there have no office on file rather
  than quietly leaving them out.
- Clicking a company opens straight to that office when your filter points at
  exactly one of its locations, and to the whole company when it points at more.
- The count on each status chip follows the rest of the bar. Filter to one state and
  the chips tell you how many researching, applied, and interviewing companies are
  left there, so the number you click is the number you get.
- Every filtered view lives in the URL, so you can share it or bookmark it and
  land on exactly the list you were looking at.
- Clicking into a company and coming back returns you to the list you left, not
  to a fresh one. The companies are already there with no second wait, you are
  back at the row you were reading rather than the top of the page, and every
  filter you had set is still set. Change something on the company page and the
  list picks up the change instead of showing you what it said before.

Each card also carries a traction badge that reads like a status report rather
than a label: "3 Contacted (2 days ago)", "2 Calls Done (2 weeks ago)", "1 Call
Scheduled (in 3 days)". You can see at a glance how much has happened at a
company and whether it has gone cold, without opening it. Only people who
currently work there count toward it, so a conversation with someone who has
since moved on never makes a company look warmer than it is. The badge says
"Call" only when the conversations behind it really were calls: a career fair, a
networking event or a text exchange reads "1 Conversation" instead.

The next move follows the same rule, because what you should do after a
conversation depends on what kind it was. A coffee chat asks you to follow up
after your call, a career fair asks you to follow up after the career fair, and a
networking event names the event. A text exchange or an "Other" conversation gets
no follow-up nudge at all: those cards simply tell you when you last spoke, so
the app never pushes you to chase something that was never a meeting.

And the card notices when the follow-up is already done. Send the thank-you
email after a call and the prompt retires into "You followed up with Lance
2 days ago", dated from your follow-up rather than the call. If they write to
you after the conversation and you have not answered, the card skips straight to
"Lance replied, write back", because responding is the follow-up.

The next move on each card answers the same question with the same honesty.
Waiting on someone reads "Waiting on Julian. You reached out 3 days ago", so the
decision to nudge is yours to make from a number rather than a shrug. And
"Samuel replied, write back" shows up only while you actually owe someone a
response: answer the thread and it settles into "You had an email thread with
Samuel (2 days ago)", which stays true even if Samuel writes again. A card should
never ask you for something you have already done.

## A network that keeps itself fresh

Contact data goes stale the moment you save it. People change jobs, get promoted,
and swap email addresses. CareerVine keeps LinkedIn-linked contacts current
automatically:

- **Automatic refresh drip**: every day a batch of your stalest contacts is quietly
  re-checked against LinkedIn, prioritizing the people you're actively working
  with. No tab open, no button to press.
- **Change alerts where you plan your day**: a job change, promotion, or work
  anniversary lands in your Up Next feed as a ready-to-act suggestion ("Sam just
  started as Senior PM at Adobe, send a congrats") at exactly the moment reaching
  out is most natural.
- **One-click refresh and email finding**: on any contact, refresh their profile on
  demand or search LinkedIn for a verified email when you don't have one, including
  when the address you had starts bouncing.
- **Fix broken links fast**: when a LinkedIn URL stops working, CareerVine notices
  and offers a guided search to re-link the right profile.
- **Spend you can see and control**: enrichment runs on a hard monthly budget, with
  automatic refreshes pausing early so manual actions always have headroom. The
  Settings, Data and Scraping tab shows month-to-date spend, run health, and the
  last refresh sweep.

New contacts saved from the browser extension are enriched automatically (photo,
real work history, and a verified email in one pass), so a two-second save produces
a complete profile.

Adding someone by hand also adds their employer to your target companies, since
choosing to save a person is already a statement about where they work. Only the
job they hold now counts, not the ones they have left, and a company you have set
to "Not a target" stays that way. Bulk imports are left out on purpose: loading a
data bundle of two thousand prospects should not turn into two thousand targets.

### Admin spend controls

For account managers, the admin dashboard adds per-account switches for all of
this: turn paid enrichment or change detection on or off for any account (or every
account at once), with each account's month-to-date spend shown right next to its
switch.

## Contact profiles that feel personal

Every contact profile supports a dedicated profile photo upload flow, so users can
keep their network visually recognizable at a glance:

- Upload a contact photo directly from the contact profile.
- Replace an existing photo anytime with a fresh image.
- Remove photos to fall back to clean initial-based avatars.

Photos are stored per account and instantly reflected across contact views, helping
users scan and recognize relationships faster.

Searching your contacts finds the person, not just the ones you happen to be
looking at. The tier chips (My network, Prospects, Archive) decide what you browse;
a search reaches every one of them, so a name you have saved always comes back even
when its tier is switched off. Matching is forgiving in the ways typing actually
goes wrong: words in either order, stray spaces, missing accents. Results come back
closest-match first, so the person whose name you typed leads, ahead of everyone who
merely shares a company or a tag with them.

Work history and education read in the order a person would tell it: whatever they
are doing now, then everything before it, newest first. The same ranking decides the
role shown under their name on the profile, in search, and on every contact card, so
someone holding several board seats no longer leads with an arbitrary one.

Editing a contact holds their whole history, not a slice of it. Education is a list
you can add to and remove from, the same as work experience, so a person with a
bachelor's and an MBA keeps both. Saving used to leave only one of them.

A contact's timeline is a way in, not just a summary. Every row opens: click a
logged conversation and you get everything recorded on it, the attendees, the full
notes, the private reminders you left yourself, its action items, the transcript and
any files, with edit and delete right there instead of on another page. Interactions
open to their full summary, an email opens to the message itself with a reply
button, and a completed action can be reopened if it turns out not to be finished.
Deleting a conversation keeps the action items that came out of it, and says so
before you confirm rather than after.

A back and forth is one conversation, not six rows. Emails on the same thread stack
into a single entry showing how many messages it holds, and open to the individual
messages when you want them, so a contact's history reads as the handful of things
that actually happened rather than every message that carried them. A sent email no
longer shows up twice either, once as the email and once as its own log entry.

Some of what lands in your history is not really history. An automated calendar
notice, a "so and so accepted your invitation" reply, a reminder nobody wrote: these
used to count as the contact replying to you, which quietly retired your follow ups
and moved the company forward. Any entry can now be struck from the record. It stays
where it is, in Gmail and on your calendar, and stops counting toward your
suggestions, your company progress and your network stats. Show removed on the
timeline brings the struck entries back into view, and puts any of them back.

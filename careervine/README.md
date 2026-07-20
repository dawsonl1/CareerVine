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

- Follow-up sequence steps are processed every 10 minutes.
- Scheduled emails are sent every 15 minutes.
- Each scheduled-email run reports delivery lag and throughput health, so capacity
  risks are visible before sends fall behind.
- On free Outreach, every pending and waiting follow-up step is visible with
  subject and date, editable before send, with confirm-to-send still applying when due.
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
- Everything saves as you type, with no save buttons, and your pipeline stage flows
  straight into the Companies dashboard so priorities stay honest.
- Email a prospect in one click (with bounced and pattern-guessed addresses clearly
  flagged), promote bench contacts into outreach, and manage office locations
  without leaving the page.

### Find the right company instantly

As your target list grows, the Companies page keeps it navigable with instant
search and stackable filters:

- Search as you type across company names, program names, and tier labels. Results
  update instantly, no page reloads.
- Narrow the list by target status (researching through closed), outreach traction,
  tier, or whether you already know someone inside.
- Filters combine, so "applied companies in Big Tech where I have no contacts yet"
  is two clicks, and a live count shows how much of your list matches.
- Every filtered view lives in the URL: share it, bookmark it, or click into a
  company and come back without losing your place.

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

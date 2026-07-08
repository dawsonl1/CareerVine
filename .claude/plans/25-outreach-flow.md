# 25 — Outreach Flow (company-by-company triage → person → email)

## What this is

A focused, session-style tool for working the target-company list: step
through companies one at a time in priority order, see the contactable
people at each with enough context to choose, open one person in a popup
for the full picture, and jump straight into the email composer addressed
to them. It turns "who should I contact at each of my 23 companies with
people?" from 23 separate page visits into one sitting.

This is a **flow**, not another browse view — the design optimizes for
speed of a decision per company, then moving on.

## Where it fits in the webapp

- **New route: `/outreach`.** Not a new nav item — the nav stays at five
  entries. Entry points:
  1. A primary button on the `/companies` dashboard header:
     **"Start outreach flow →"** (this is the natural home — that page is
     where target priorities live).
  2. Direct URL, bookmarkable.
- **Position in the URL is stateful**: `?company=<id>` updates as you
  navigate, so refresh/back/forward keep your place mid-session, and a
  specific company's triage screen is linkable.
- **Reuses, never duplicates**: the existing compose modal (AI drafting,
  templates, scheduled send, follow-up sequences — all already built) is
  THE email writer; the popup opens it prefilled. Company/person data
  comes from the plan-24 query layer (`getCompanies`, `getCompanyDetail`,
  `getContactById`). No new API routes, no migration.

## The queue (which companies, in what order)

- Target companies only, `status != 'closed'`, that have **≥1 contactable
  person** (`active` or `prospect`; bench does not qualify a company —
  containment holds).
- Ordered by **priority score desc** (nulls last, then name). If a real
  `next_app_date` exists and is within 30 days, the company is boosted to
  the front of the queue (deadline beats generic priority).
- Header shows honest progress: **"Company 4 of 23"** with Prev / Next
  buttons and ←/→ keyboard navigation. A compact company dropdown lets
  you jump anywhere in the queue without stepping.
- Companies with people only on the bench don't appear in the queue, but
  the empty-ish state on their neighbors never lies: the queue count is
  what it is. (A small footer line under the queue header: "N more target
  companies have only bench people or nobody — review them on
  /companies".)

## Screen layout (top to bottom)

```
┌──────────────────────────────────────────────────────────────┐
│  ← Prev   Company 4 of 23   [company jumper ▾]        Next → │
├──────────────────────────────────────────────────────────────┤
│  [logo] Google              priority 87 · APM Program        │
│  Apps: Oct 15, 2026 · researching     [full company page ↗]  │
│  Latest intel: "Recruiter said apps open mid-Oct…" (2 notes) │
├──────────────────────────────────────────────────────────────┤
│  CURRENT EMPLOYEES (5)                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                │
│  │ ◉ Jane Doe │ │ ◉ Sam Lee  │ │ ◉ A. Kumar │   … cards      │
│  │ APM II     │ │ PM, Search │ │ Recruiter  │                │
│  │ Alum·Prod  │ │ Peer  adj71│ │ Recruiter  │                │
│  │ "BYU alum  │ │ "Strong    │ │            │                │
│  │  on core…" │ │  adjacency"│ │            │                │
│  │ ✉ contacted│ │ ✉ not yet  │ │ ⚠ guessed  │                │
│  └────────────┘ └────────────┘ └────────────┘                │
│  FORMER EMPLOYEES (2)  — smaller, collapsed by default       │
└──────────────────────────────────────────────────────────────┘
```

### Company context strip
Name + logo, priority score, program name, target status, `next_app_date`
(or the window-text hint in italics), a link out to the full
`/companies/[id]` page, and the **latest recruiting note** (one line,
expandable) so intel learned on a call is in view while choosing who to
email. Bench count shown as a muted note ("+ 12 on the bench ↗" linking
to the company page) — visible, never mixed in.

### Person cards (the decision surface)
Active + prospect people. Current employees first (persona-ranked:
recruiter/leader/alum-product first), former employees in a collapsed
secondary section. Each card carries exactly what's needed to choose:

- Photo, name, current title at this company
- Persona badge, BYU-alum badge, location (office facet)
- **The AI reviewer's one-line reason** (`review_note`) — this is the
  pipeline's "why this person" and is the highest-value line on the card
- Adjacency score (muted, for tiebreaks)
- Outreach stage chip (derived — so someone already contacted is visibly
  distinct) and email status: ✉ present / ⚠ pattern-guessed / bounced
- Cards with no email at all render with a muted "no email" tag (still
  clickable — the popup links to their LinkedIn)

Clicking a card opens the person popup.

## Person popup (existing `Modal`, size lg)

Lazy-loads the full contact via `getContactById` when opened.

- **Header**: photo, name, headline, LinkedIn link, location, badges
  (persona, alum, stage, tier).
- **Why they were kept**: `review_note` + `selection_reason` — the
  pipeline's judgment, verbatim.
- **At this company**: every stint (title, dates, office, remote flag).
- **Elsewhere**: other current roles + up to ~4 past roles (from the full
  contact record).
- **Education**: schools/degrees/years.
- **Email**: address + source label (verified / scraped /
  pattern-guessed with warning styling / bounced in red).
- **Actions** (bottom bar):
  - **Primary: "Write email"** — closes the popup and opens the existing
    compose modal prefilled (`to`, `name`, `contactId`). Everything
    downstream is already built: AI draft, schedule, follow-up sequence,
    and on send → interaction logged → contact auto-graduates to
    `active` → derived stage flips to `contacted`.
  - "Open full profile" → `/contacts/[id]`.
  - "Mark contacted" (small, text style) — sets `stage_override` for
    LinkedIn-DM outreach that happened off-platform.

After the compose modal closes, the flow refreshes the current company's
people so the stage chip reflects the send immediately.

## Keyboard model

- `←` / `→` — previous / next company (disabled while popup or compose
  is open)
- `Esc` — close popup (Modal already does this)
- No other bindings; this isn't a power-tool with a manual.

## What it deliberately does NOT do

- No bench people on cards (containment; the bench link goes to the
  company page where promotion lives).
- No auto-advance after sending — choosing to move on is the user's
  action (you might email two people at one company).
- No per-company "done" checkmarks or persisted session state in the DB —
  the stage chips ARE the progress record; a separate done-flag would rot.
- No duplicate email writer — the compose modal is the only composer.

## Implementation notes

- **New files**: `src/app/outreach/page.tsx` (+ a `PersonModal` component,
  colocated or in `src/components/companies/`).
- **Query layer**: reuse `getCompanies(targetsOnly)` +
  `getCompanyDetail(companyId)` + `getContactById`. Already added (small
  uncommitted change): `review_note` + `selection_reason` on
  `CompanyPerson`.
- **Queue builder**: pure function `buildOutreachQueue(summaries)`
  (filter contactable + not closed, sort priority w/ app-date boost) in a
  lib module — unit-tested (ordering, app-date boost, zero-people
  exclusion, closed exclusion).
- **Entry button** on `/companies` header.
- Tests: queue builder + any pure helpers; `npm run test` green before
  commit (rule 4).

## Sizing

Small-medium: one page, one modal, one pure helper + tests. No schema, no
API, no pipeline-side changes.

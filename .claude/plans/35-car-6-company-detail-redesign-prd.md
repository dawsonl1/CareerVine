# 35 — CAR-6 Company Detail Page Redesign (PRD)

**Linear:** [CAR-6 — Fix Company UI](https://linear.app/career-vine/issue/CAR-6/fix-company-ui)

**Route:** `/companies/[id]` (`careervine/src/app/companies/[id]/page.tsx`)

**Status:** PRD draft — redesign will land incrementally; Dawson specifies one fix at a time.

---

## 1. Problem statement

The company detail page is CareerVine's **recruiting command center** for a single employer. After a pipeline import or a few coffee chats, a target company can have dozens of scraped prospects, multiple offices, and a growing intel log — but the current layout treats everything as one long scroll of equal-weight cards.

Users open this page to answer three questions quickly:

1. **Where am I in the process** with this company (status, app timing, what I've learned)?
2. **Who should I contact next** at this company (and at which office)?
3. **What do I know** that I shouldn't have to re-derive on every visit?

The page has the right *data* (people split, location facets, target metadata, notes, bench containment) but the *presentation* doesn't yet prioritize those decisions. CAR-6 is a UX redesign — not a data-model change — unless a story explicitly requires one.

---

## 2. Product context

### Primary user

A job seeker running a structured recruiting campaign (e.g. PM/APM programs, IB, consulting) who:

- Imports or manually builds a roster of prospects per target company
- Researches application windows, referral paths, and team structure
- Executes outreach from inside CareerVine (Gmail compose, stage tracking)
- Returns to the same company page repeatedly across weeks/months

### Entry paths

| Path | Intent |
|------|--------|
| `/companies` → click a target | Pick up where I left off on a priority company |
| Contact profile → company link | See who else I know at the same employer |
| Pipeline import (bulk) | Review imported roster and start outreach |
| MCP / AI operator | Same questions, but via chat — UI must stay consistent with tool semantics |

### Relationship to `/companies` (list page)

The **list page** answers "which companies need attention?" (priority, traction, app dates). The **detail page** answers "what do I do at *this* company right now?" CAR-6 scope is the detail page only; list-page changes are out of scope unless a story explicitly requires parity.

---

## 3. Current state (v1 — shipped in plan 24)

### What exists today

**Header**
- Company name, contact count (+ bench count), LinkedIn link *(logo removed — see §17; domain removed — see §17)*
- Target controls: status dropdown (`researching` → `closed`), inline `next_app_date` editor
- Display-only `app_window_text` hint below header
- Non-target companies show "Add to targets"

**Location layer**
- Facet chips: `All` + top 8 offices (+ "N more") with per-location counts; `?location=` URL param scopes people
- "Manage offices" inline panel: add manual office, delete inferred offices (phantom correction)

**People**
- **Current employees** — `active` + `prospect` only; persona badge, BYU alum badge, derived outreach stage, title/location, scrape staleness, email compose (with pattern-guess warning + bounce surfacing)
- **Former employees** — same card pattern
- **Bench** — single collapsed section, adjacency score, "Add to outreach" promote action; never mixed into primary counts

**Recruiting intel (sidebar)**
- Timestamped notes with optional office tag; add/delete
- Requires target membership

### Data the page already exposes (via `getCompanyDetail`)

`company`, `target` (+ notes), `offices`, `facets`, `current`, `former`, `bench` — see `careervine/src/lib/company-queries.ts`.

### Related but out of v1 UI

- `priority_score`, `tier`, `program_name` on target (shown on list page, not detail header today)
- `review_note` / `selection_reason` on imported contacts (stored, not surfaced on cards)
- Stage override / "mark as contacted" (supported in data layer; no detail-page action)
- Companies with **zero contacts** (CAR-18 — add company without contacts — not yet in UI)

---

## 4. Observed UX gaps (hypotheses — validate during redesign)

These are starting observations from the current Capital One screenshot + code review. Dawson will confirm, reject, or reprioritize item-by-item.

| Area | Observation |
|------|-------------|
| **Visual hierarchy** | Header, window hint, facet row, and first people section compete for attention; recruiting workflow state feels disconnected from the people list |
| **Information density** | Person cards repeat similar metadata (persona + stage + title + location + staleness) in a tall card; hard to scan 10+ people |
| **Facet overflow** | Many offices wrap to multiple rows; "Manage offices" floats at the end of the chip row |
| **Sidebar placement** | Recruiting notes start below the fold while people fill the left column — intel capture may not feel "always available" after a call |
| **Target metadata** | Priority, tier, and program name aren't visible on detail — user may context-switch back to list |
| **Empty / edge states** | Zero contacts, zero current employees, non-target company — flows exist but aren't designed as first-class |
| **Actions** | Primary actions (email, promote from bench, add note) aren't grouped into a clear "what's next" pattern |
| **Mobile** | Two-column grid likely collapses awkwardly; not yet validated |

---

## 5. Design principles (for this page)

1. **Recruiting decisions first** — status, timing, and intel sit above the fold and frame the people lists.
2. **Scan, then act** — people rows optimized for comparing many prospects; actions reachable in one click.
3. **Location is a lens, not a filter maze** — facets stay lightweight; selected office persists in URL.
4. **Bench stays invisible until invited** — never pollute primary counts or outreach mental model.
5. **Capture intel at the moment of learning** — note entry should be frictionless immediately after a call (the README's "best moment to add one is right after a call").
6. **Honest data** — staleness, pattern-guessed emails, and bounces stay visible; never hide scrape limitations.
7. **Incremental ship** — each story should be independently deployable; no big-bang rewrite required.

---

## 6. Personas

### Persona A — "I just got off a recruiter call"

**Context:** Learned app timing, referral process, or team structure. Needs to log notes and maybe update status/date before forgetting.

**Jobs to be done:** Capture intel → update target state → identify who to email next.

---

### Persona B — "I'm doing outreach at this company today"

**Context:** Block of time set aside to work one employer from the target list.

**Jobs to be done:** Filter by office → find highest-value not-contacted prospects → send emails → track stage movement.

---

### Persona C — "I'm researching before I have anyone there"

**Context:** Company added as target (or will be, via CAR-18) with no contacts yet — planning phase.

**Jobs to be done:** Set offices, log research notes, track app window, prepare for future import.

---

### Persona D — "I'm triaging a fresh pipeline import"

**Context:** 8 selected + 50 bench just landed from scrape import.

**Jobs to be done:** Scan selected roster → promote a few bench people → ignore the rest → start outreach on recruiters/alums first.

---

## 7. User stories

Stories use **MoSCoW** tags: **M** Must, **S** Should, **C** Could, **W** Won't (this release).

### Epic 1 — Company identity & target state

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C1.1 | **M** | As a user, I want to see this company's name and LinkedIn link so I know I'm on the right employer. | Name, LinkedIn — no logo (not scraped) |
| C1.2 | **M** | As a user, I want to see and change my recruiting **status** for this company so my pipeline view stays accurate. | Status dropdown; persists on change |
| C1.3 | **M** | As a user, I want to set a **real application date** when I learn one so I can sort and plan around it. | Inline date editor; clears optional |
| C1.4 | **S** | As a user, I want to see the **historical window hint** separately from a real date so I don't confuse research notes with deadlines. | Hint is display-only, visually distinct |
| C1.5 | **S** | As a user, I want to see **priority, tier, and program name** on the detail page so I don't bounce back to the list for context. | Pulled from `target_companies` |
| C1.6 | **M** | As a user, I want to **add a non-target company to my targets** from this page so I can start logging intel. | "Add to targets" → target controls appear |
| C1.7 | **C** | As a user, I want a one-glance **progress summary** (e.g. 3 contacted · 2 replied · 5 not contacted) so I know traction without reading every card. | Aggregated from derived stages |

### Epic 2 — Location & offices

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C2.1 | **M** | As a user, I want to filter people by **office location** so I can focus outreach geographically. | Facet chips; URL param; counts update |
| C2.2 | **M** | As a user, I want **Remote** and **Unknown** buckets when location data is incomplete so nobody disappears from the roster. | Honest buckets per plan 24 |
| C2.3 | **S** | As a user, I want facet overflow handled cleanly when a company has many offices (e.g. Google-scale). | Top-N + expand; no unbounded wrap |
| C2.4 | **M** | As a user, I want to **add a manual office** before I have contacts there so location-scoped notes and filters work early. | Manage offices → add |
| C2.5 | **M** | As a user, I want to **remove a bad inferred office** without deleting first-person location evidence on profiles. | Delete office; cascade rules per plan 24 |
| C2.6 | **C** | As a user, I want the selected location reflected in the page title or breadcrumb so I don't lose context when scrolling. | e.g. "Capital One · New York" |

### Epic 3 — People roster (current / former)

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C3.1 | **M** | As a user, I want **current** and **former** employees in separate sections so I know who works there now. | Sections with counts |
| C3.2 | **M** | As a user, I want each person row to show **role, location, persona, and outreach stage** so I can prioritize. | Badges + stage colors |
| C3.3 | **M** | As a user, I want to **email a prospect** in one click when Gmail is connected. | Compose modal; respects bounce block |
| C3.4 | **M** | As a user, I want **pattern-guessed** and **bounced** emails flagged so I don't burn reputation. | Warning icon / label |
| C3.5 | **S** | As a user, I want to see **scrape staleness** ("Data as of …") so I know when to refresh LinkedIn data. | `last_scraped_at` |
| C3.6 | **S** | As a user, I want **BYU alum** and **persona** badges to stand out for recruiting prioritization. | Visual distinction |
| C3.7 | **S** | As a user, I want person rows to be **scannable in bulk** (10–20 people) without excessive card height. | Redesign target — TBD layout |
| C3.8 | **M** | As a user, I want to open a person's **full contact profile** from their row. | Link to `/contacts/[id]` |
| C3.9 | **C** | As a user, I want to see **why the pipeline selected** someone (`selection_reason` / review note) without opening their profile. | Collapsed or tooltip |
| C3.10 | **C** | As a user, I want to **mark someone as contacted** when outreach happened off-email (LinkedIn DM). | Sets `stage_override` |

### Epic 4 — Bench (dormant pipeline data)

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C4.1 | **M** | As a user, I want bench people **hidden by default** so 70 alumni don't bury my 8 selected contacts. | Collapsed section |
| C4.2 | **M** | As a user, I want bench count shown **separately** from active contact count in the header. | "16 contacts · 58 bench" |
| C4.3 | **M** | As a user, I want to **promote** a bench person to outreach with one action. | `network_status` → `prospect` |
| C4.4 | **S** | As a user, I want bench rows sorted by **adjacency score** when expanded. | Pipeline ranking |
| C4.5 | **M** | As a user, I want bench lists **scoped by the same location filter** as primary sections. | Facet applies everywhere |

### Epic 5 — Recruiting intel (notes)

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C5.1 | **M** | As a user, I want to **add timestamped notes** after calls so intel accumulates over time. | Textarea + Add |
| C5.2 | **M** | As a user, I want to tag a note as **company-wide or office-specific** so location research stays organized. | Location select on note |
| C5.3 | **M** | As a user, I want to **delete** a note I added by mistake. | Trash action |
| C5.4 | **S** | As a user, I want the note composer **easy to reach after a call** without hunting below the fold. | Placement/redesign TBD |
| C5.5 | **C** | As a user, I want notes **newest first** with relative timestamps for quick scanning. | Sort order |
| C5.6 | **W** | As a user, I want to edit an existing note in place. | Out of scope unless requested — delete + re-add works today |

### Epic 6 — Navigation & empty states

| ID | Priority | Story | Acceptance hints |
|----|----------|-------|------------------|
| C6.1 | **M** | As a user, I want a clear **back to Companies** path so list ↔ detail navigation is obvious. | Breadcrumb / back link |
| C6.2 | **S** | As a user with **no contacts** at a target company, I want guidance on what to do next (add office, log note, import). | Empty state copy + CTAs |
| C6.3 | **S** | As a user on a **non-target** company, I want to understand why notes are disabled and how to enable them. | Explain + CTA |
| C6.4 | **C** | As a user, I want a shortcut to **Start outreach flow** filtered to this company. | Link to `/outreach` with context |

---

## 8. Proposed information architecture (working draft)

Exact layout TBD through incremental stories. Starting strawman to align discussion:

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Companies                                                     │
├─────────────────────────────────────────────────────────────────┤
│ Capital One                            [Status ▾] [App date]    │
│         16 contacts · 3 bench · Priority 87 · APM Program       │
│         Window hint (italic, secondary)                         │
├─────────────────────────────────────────────────────────────────┤
│ Traction strip (optional): 5 not contacted · 2 contacted · …    │
├─────────────────────────────────────────────────────────────────┤
│ Location facets (single row / overflow menu)     Manage offices │
├───────────────────────────────┬─────────────────────────────────┤
│ PEOPLE (primary, ~2/3)        │ INTEL (sticky sidebar, ~1/3)    │
│ Current employees (13)        │ Recruiting notes                │
│  [scannable rows]             │  [composer always visible]      │
│ Former employees (3)          │  [note history]                 │
│ ▸ N on the bench              │                                 │
└───────────────────────────────┴─────────────────────────────────┘
```

Dawson's item-by-item feedback will replace sections of this wireframe.

---

## 9. Functional requirements

| Req | Description |
|-----|-------------|
| FR-1 | Page loads company detail for authenticated user; 404-style empty state if company missing |
| FR-2 | Location filter persists in `?location=` query param; shareable/bookmarkable |
| FR-3 | All mutations (status, date, notes, offices, promote) refresh view without full page reload |
| FR-4 | Bench people never appear in current/former sections or contact-count traction |
| FR-5 | Email compose respects Gmail connection, bounce state, and existing compose modal |
| FR-6 | Office delete follows plan-24 cascade semantics (profile_match cleared; experience kept) |
| FR-7 | Accessible: keyboard-navigable facets, labeled form controls, sufficient contrast on stage badges |

---

## 10. Non-goals (CAR-6)

- Bulk import UI, scrape pipeline controls, or MCP tool changes
- `/companies` list page redesign (unless a detail story forces parity)
- New database tables or migrations (prefer existing `target_companies`, `company_locations`, `target_company_notes`) — **exception: §18 location-scoped targets requires extending `target_companies`**
- AI-generated company summaries or auto-drafted outreach from this page
- Slug-based URLs (`/companies/capital-one`) — numeric id is fine for now
- "Broader network" (`network_scope = broad_network`) dedicated view

---

## 11. Dependencies & related tickets

| Ticket | Relationship |
|--------|--------------|
| [CAR-18](https://linear.app/career-vine/issue/CAR-18) | Add companies without contacts — empty-state stories should align when it ships |
| Plan 24 | Data model + v1 behavior — this redesign must not break bench containment or office cascade rules |
| `/outreach` (plan 25) | Optional deep-link from detail page |

---

## 12. Success metrics

Qualitative (primary for a solo-user product):

- Dawson can complete a post-call workflow (note + status/date update) in under 60 seconds without scrolling hunt
- Scanning 15 prospects to pick the next email target takes under 30 seconds
- Bench roster never feels like clutter on high-import companies

Quantitative (if analytics added later):

- Time-on-page with ≥1 mutation (note, status, email compose, promote)
- Promote-from-bench rate vs. bench size

---

## 13. Delivery approach

1. **PRD + stories locked** (this doc) — Dawson reviews priorities
2. **Incremental UI slices** — one user-visible fix per commit/PR slice, validated in browser at localhost:3000
3. **Regression** — existing Vitest coverage for `company-queries` stays green; add component tests only when behavior changes
4. **README** — product bullet updated when redesign materially changes the company-page promise

### Story tracking

As Dawson names each fix, map it to a story ID above (e.g. "C3.7 scannable rows") and check it off in Linear comments.

---

## 14. Open questions

1. Which epics are **Must** for v1 of the redesign vs. nice-to-have?
2. Should **priority / tier / program** move into the header or a dedicated "Target" card?
3. Should recruiting notes be **sticky** on desktop while scrolling people?
4. Preferred person row density: **compact list** vs. **cards** vs. **table**?
5. Any **mobile** usage expected, or desktop-first is acceptable?
6. Should we surface a **"what to do next"** recommendation on this page (ties to home/outreach)?

---

## 15. Revision log

| Date | Change |
|------|--------|
| 2026-07-09 | Initial PRD + user stories from v1 implementation audit and Capital One screenshot |
| 2026-07-09 | Added §16 — current-state information audit (render order + Capital One example) |
| 2026-07-09 | **Decision 1:** Remove company logo/initial from detail header — logos aren't scraped; column stays in DB for list/outreach until those are updated |
| 2026-07-09 | **Decision 2:** Back link (§16.1.1) — hover surface pill + arrow nudge + text brighten |
| 2026-07-09 | ~~Decision 3: LinkedIn icon-only (Lucide)~~ — **rejected** |
| 2026-07-09 | **Decision 4:** Remove `companies.domain` from schema and UI — website not needed |
| 2026-07-09 | **Decision 5:** Target membership card in right column — **superseded by §18** |
| 2026-07-09 | Added §19 — location navigation rethink (chips → scope nav); blocks §18 until IA chosen |
| 2026-07-09 | **§18–19 superseded by §20** — location-first model; company stores identity only |
| 2026-07-09 | **§20 superseded by §21** — hybrid company-wide + per-office; both general application and office tracking |
| 2026-07-09 | Added §22 — outreach stage UX (pipeline preview); not-contacted excluded; company-wide not program-scoped; manual offline log in preview |
| 2026-07-09 | Added §23 — Applied multi-job applications + PDF resume/cover letter uploads |

---

## 20. Location-first recruiting model (proposed — **superseded by §21**)

**Status:** ~~Direction from Dawson (Jul 2026).~~ **Rejected** — Dawson needs **both** company-wide general application tracking **and** per-office tracking. See §21.

**Core principle:** The company record holds **identity only**. Recruiting state — target, status, dates, priority, notes, traction — lives on **locations**, not on the company.

This matches the original schema intent:

> `company_locations` — *"anchor for location-scoped recruiting intel"* (migration `20260707000000`)

`target_companies` was the wrong abstraction layer. We built company-wide targets and tried to bolt location on later; the redesign inverts that.

---

### 20.1 Mental model shift

| | Company-centric (§18–19) | Location-first (§20) |
|--|--------------------------|----------------------|
| **Primary unit** | Company, with optional location scope | **Location** (office / Remote / Unknown) |
| **Company stores** | Target, status, dates, notes container | Name, LinkedIn, logo — identity only |
| **"Target Capital One"** | One row on `target_companies` | Target one or more **locations** under Capital One |
| **Notes** | Company-wide + optional location tag | **Always belong to a location** (no floating company-wide intel) |
| **Page structure** | Pick scope → see filtered people | **Stack of location blocks**, each self-contained |
| **Navigation** | Rail / dropdown / chips | Scroll the page — no scope picker |

```
Company-centric:  Capital One [container] → pick NYC → see NYC slice
Location-first:   Capital One [label]     → NYC block, McLean block, Remote block …
                  each block owns its own target + notes + people
```

---

### 20.2 What the company record holds

**`companies` — thin identity shell:**

| Field | Keep? |
|-------|-------|
| `name`, `linkedin_url`, `universal_name`, `logo_url` | Yes |
| Everything on `target_companies` | **Move to locations** |
| Company-wide notes | **Eliminate** — see §20.5 |

The company detail page header becomes:

```
← Companies
Capital One · 16 contacts · LinkedIn
```

No status dropdown, no app date, no target card in the header. Those live **inside each location block**.

---

### 20.3 Data model (proposed)

#### Option A — Extend `company_locations` (recommended)

Each `(company_id, location_id)` row becomes the recruiting unit:

```sql
ALTER TABLE company_locations
  ADD COLUMN user_id uuid REFERENCES users(id),  -- or separate user-scoped join table
  ADD COLUMN is_targeted boolean NOT NULL DEFAULT false,
  ADD COLUMN status text CHECK (status IN (...)),
  ADD COLUMN priority_score numeric,
  ADD COLUMN tier text,
  ADD COLUMN program_name text,
  ADD COLUMN app_window_text text,
  ADD COLUMN next_app_date date,
  ADD COLUMN updated_at timestamptz;
```

**Problem:** `company_locations` is currently shared (not user-scoped) — any user can see offices. Recruiting state is **per user**.

#### Option B — `user_company_locations` (cleaner)

New user-scoped table, 1:1 with a `company_locations` row when the user has recruiting activity there:

```sql
CREATE TABLE user_company_locations (
  id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_location_id int NOT NULL REFERENCES company_locations(id) ON DELETE CASCADE,
  is_targeted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'researching',
  priority_score numeric,
  tier text,
  program_name text,
  app_window_text text,
  next_app_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_location_id)
);
```

Notes FK here (or to `company_location_id` + `user_id`):

```sql
CREATE TABLE location_notes (
  id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_company_location_id int NOT NULL REFERENCES user_company_locations(id) ON DELETE CASCADE,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Migrate from today:**
- Each `target_companies` row → seed `user_company_locations` for all existing `company_locations` of that company (or only locations with contacts)
- `target_company_notes` → `location_notes` (map via `location_id` → `company_location_id`)
- Deprecate `target_companies`, `target_company_notes`

#### Virtual location buckets

Not every person sits in a `company_locations` row today. Still need:

| Bucket | Implementation |
|--------|----------------|
| **Remote** | Synthetic `company_locations` row per company, or virtual row in query (`workplace_type = remote`) |
| **Unknown** | Synthetic row for `location_id IS NULL` employment |
| **Manual office, 0 contacts** | Real `company_locations` row (already supported) — user can target before people arrive |

---

### 20.4 UI — location stack (not rail, not chips)

**One scrollable page.** Each location is a **block** — a mini recruiting workspace.

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Companies                                                     │
│ Capital One · 16 contacts · LinkedIn                            │
│ [ + Add office ]   [ Target all locations… ]  (bulk actions)    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌─ New York, New York ─────────────────────── ● Targeted ─────┐ │
│ │ Outreach active ▾    Apps: Sep 15, 2026    [ Remove target ] │ │
│ │ 4 contacts · 1 replied                                       │ │
│ │                                                              │ │
│ │ Recruiting notes                                             │ │
│ │  · NYC apps open late August …              Jul 5            │ │
│ │  [ What did you learn? …                          + Add ]      │ │
│ │                                                              │ │
│ │ Current employees (3)                                        │ │
│ │  [person rows…]                                              │ │
│ │ Former (1) · ▸ 0 bench                                       │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ McLean, Virginia ──────────────────────── ○ Not targeted ─┐ │
│ │ 3 contacts                              [ Target this location ]│
│ │ ▸ Show people & notes                                        │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ Remote ──────────────────────────────────── ● Targeted ─────┐ │
│ │ Researching ▾    Set app date                                │ │
│ │ …                                                            │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Block behavior:**

| State | Default view |
|-------|--------------|
| **Targeted** | Expanded — status, dates, notes, people visible |
| **Not targeted** | Collapsed one-liner — name, contact count, **[ Target this location ]** |
| **Expand** | User can expand non-targeted blocks to browse people without targeting |

**Sort order:** Targeted locations first (by priority / app date), then by contact count, then alphabetical. Remote / Unknown at bottom unless targeted.

**No chips. No rail. No dropdown.** The page *is* the list of locations.

**Bulk actions** (header toolbar, not stored metadata):
- **Target all locations** — sets `is_targeted` on every `company_locations` row for this company
- **Target all with contacts** — only locations that have people today

These replace "target entire company" without a company-level row.

---

### 20.5 Company-wide intel — what happens?

Dawson's direction: company shouldn't store this. Options:

| Approach | Behavior |
|----------|----------|
| **A. No company-wide notes** | Every note must live in a location block. General intel → pick a location or add a **"General"** manual office. |
| **B. "General" pseudo-location** | Auto-create a `company_locations` row labeled "Company-wide" or "General" — still a location row, not company metadata. |
| **C. Duplicate on save** | User writes a note once, picks multiple locations — stored as copies. (Probably overkill.) |

**Recommendation:** **B** for edge cases ("referrals go through employee portal" applies everywhere) — but it's still a **location row**, keeping the model pure. Most intel naturally belongs to NYC, McLean, etc.

**Cross-location visibility:** When viewing NYC block, you only see **NYC notes**. No inherited company-wide section — if general intel matters everywhere, it lives in the General block (user expands it when needed) or user duplicates manually. Simpler than §18's layered notes.

*If Dawson wants general notes visible inside every location block without duplication, that's a **read rule** (show General block's notes as a muted subsection) — still stored in one place.*

---

### 20.6 `/companies` list page

Company appears in **Targets** view if **any location** has `is_targeted = true`.

Card shows aggregate, not company-level status:

```
Capital One
New York · Outreach active · Apps Sep 15
McLean · Researching
4 locations targeted · 16 contacts
```

Sort: max `priority_score` or nearest `next_app_date` across targeted locations.

No company-level `status` field — card subtitle is derived from location rows.

---

### 20.7 Resolves prior open questions

| Old question (§18.12) | Location-first answer |
|-----------------------|----------------------|
| Different status per scope? | **Yes, trivially** — each location has its own row |
| Inherited company-wide on office lens? | **Gone** — no inheritance; each location is independent |
| Remove company-wide, keep offices? | **N/A** — no company-wide target to remove |
| Priority / tier / program per scope? | **Per location row** |
| Notes FK / container? | **FK to `user_company_locations`** |
| Location navigation pattern? | **Location stack** — no picker |

---

### 20.8 Tradeoffs (honest)

| Gain | Cost |
|------|------|
| Model matches how recruiting actually works (geo-specific) | "Target whole company" = bulk action, not one toggle |
| No inheritance rules to learn | General/cross-office intel needs General location or duplication |
| Page scales — add locations = add blocks | Long scroll for 15+ locations (mitigate: collapsed non-targeted) |
| Simpler queries — one row = one workspace | Migration from `target_companies` |
| Aligns with original `company_locations` design | `/outreach` queue must aggregate across location targets |

---

### 20.9 Open questions (location-first)

1. **General / company-wide intel:** Pseudo-location row (recommended), or no company-wide notes at all?
2. **Target all:** One-click target every location, or wizard to pick which?
3. **Non-targeted blocks:** Always collapsed, or expanded if they have contacts?
4. **Remote / Unknown:** Full blocks like offices, or grouped footer section?
5. **Pipeline import:** Sheet has one row per company — seed all locations as targeted, or create one targeted location from tier/geo hint?
6. **Former employees:** Show in each location block where they worked, or separate company-level "Former" section? (Leaning: per-location, since everything is location-tied.)

---

### 20.10 Implementation phases (if approved)

| Phase | Scope |
|-------|-------|
| **0** | Revert Decision 5 sidebar card |
| **1** | `user_company_locations` + `location_notes` migration; deprecate `target_companies` |
| **2** | Location stack UI — targeted expanded, non-targeted collapsed |
| **3** | Bulk target actions; `/companies` list derives from locations |
| **4** | `/outreach` queue reads location targets |
| **5** | General pseudo-location + import seeding rules |

**§18, §19, and company-level target UI are frozen** until §20 direction is confirmed.

---

## 21. Hybrid company + location model (current direction — Jul 2026)

**Status:** Confirmed by Dawson. Supersedes pure §20 location-first.

**Core principle:** Recruiting state exists at **two independent layers**:

1. **Company-wide** — "I applied to Capital One generally" (status, app date, general notes). Maps to today's `target_companies` with `location_id = null`.
2. **Per office** — "I'm actively networking into NYC" (status, app date, office notes). Maps to `target_companies` with a `location_id`, or future `user_company_locations`.

Both can coexist with **different statuses** (company = Applied, NYC = Outreach active).

### 21.1 Mental model

```
Capital One (identity)
├── Company-wide target  → Applied · Apps Oct 1 · general notes
├── New York office      → Outreach active · office notes · NYC people
├── McLean office        → Researching · …
└── All tab              → full roster + company-wide controls + all notes (read)
```

- **All tab** = roster + **General application** bar (company-wide status/date) + company-wide notes composer.
- **Office tabs** = office workspace; show muted **Company-wide: Applied** banner when company layer exists so context isn't lost.
- **No inheritance** — editing NYC does not change company-wide unless user explicitly chooses to (§18.12 Option B fork pattern still applies for office rows created from company-wide).

### 21.2 What §20 got wrong

| §20 claim | Hybrid correction |
|-----------|-------------------|
| Company stores identity only | Company also stores **optional company-wide target** |
| Eliminate company-wide notes | **Keep** company-wide notes (`location_id` null) |
| "Target whole company" = bulk all locations | **Separate** — general application ≠ targeting every office |
| No inherited company-wide on office lens | **Show read-only company-wide line** on office tabs for context |

### 21.3 UI (tabs preview — `/companies/[id]/preview/tabs`)

| Surface | Company-wide | Office-specific |
|---------|--------------|-----------------|
| **All tab header** | General application controls | — |
| **All tab notes** | Composer + company-wide notes; office notes shown read-only with location label | — |
| **Office tab header** | Muted banner if company-wide exists | Full target controls |
| **Office tab notes** | — | Office notes only |
| **People list** | All contacts + compact location suffix on roles | Filtered to office |

Pills: `All` + real offices only (Remote/Unknown footnote on All).

### 21.4 Data model (extends §18, not §20)

Keep **`target_companies`** as the scope table:

- `location_id IS NULL` → company-wide scope
- `location_id = <office>` → office scope
- Unique `(user_id, company_id, location_id)` — one row per scope

Notes: FK to scope row **or** `company_id` + `location_id` on notes table (§18 Q5 — still open).

**Do not** migrate away from company-wide targets. Add/enable location rows alongside.

### 21.5 `/companies` list

Show company if **any** scope is targeted (company-wide OR any office).

Card subtitle (derived):

```
Capital One
Applied (company-wide) · Apps Oct 1
New York · Outreach active
2 offices tracked · 16 contacts
```

### 21.6 Open questions

1. **Fork office from company-wide:** Option B from §18.12 still recommended when user first edits office status.
2. **Remove company-wide while offices remain:** Philosophy 2 from §18 Q4 — notes persist, target row cleared.
3. **Priority/tier/program:** Company-wide default vs per-office override when forked (§18.12 Option C pattern).

### 21.7 Preview implementation (CAR-6)

| Date | Change |
|------|--------|
| 2026-07-09 | §21 hybrid model; tabs preview All tab gets General application bar; office tabs show company-wide banner |

---

## 16. Current-state information audit (render order)

Top-to-bottom inventory of everything the company detail page can show, in render order. **Capital One** is the concrete example (screenshot, Jul 2026).

**Page structure:** global nav → back link → header → window hint → location facets → (optional) manage offices → two-column body (people left, notes right).

### 0. Global navigation *(app shell, not company-specific)*

| # | What the code shows | Capital One screenshot |
|---|---------------------|------------------------|
| 0.1 | CareerVine logo + brand | ✅ CareerVine + sprout |
| 0.2 | Nav tabs: Home, Activity, Contacts, **Companies**, Actions | ✅ Companies highlighted |
| 0.3 | Inbox icon, Calendar icon | ✅ Both visible |
| 0.4 | User avatar (initial) | ✅ Green circle **D** |
| 0.5 | Sign out | ✅ Visible |

### 1. Back navigation

| # | What the code shows | Capital One | Interaction |
|---|---------------------|-------------|-------------|
| 1.1 | `← Companies` link → `/companies` | ✅ Visible above header | Hover: surface pill, text brightens, arrow nudges left |

### 2. Company header *(single row, wraps on narrow screens)*

**Left cluster**

| # | Field | Source | Condition | Capital One (v1) | After redesign |
|---|-------|--------|-----------|------------------|----------------|
| 2.1 | Company name | `company.name` | Always | ✅ **Capital One** | ✅ |
| 2.2 | Contact count | Unique `current` + `former` people (excludes bench) | Always | ✅ **16 contacts** | ✅ |
| 2.3 | Bench count | `bench.length` | Only if bench > 0 | ❌ Not shown → **0 bench** | ✅ |
| 2.4 | LinkedIn link | `company.linkedin_url` | If set | ✅ **LinkedIn** text + external-link icon | ✅ (wordmark reverted) |
| 2.4 | LinkedIn link | `company.linkedin_url` | If set | ✅ **LinkedIn** text + external-link icon | ✅ |
| ~~2.5~~ | ~~Domain link~~ | — | **Removed** (Decision 4) | — | — |

~~2.x Logo image / initial fallback~~ — **removed** (Decision 1). `logo_url` still fetched but not rendered on detail page.

**Right cluster — target controls** *(only if company is a target)*

| # | Field | Source | Capital One |
|---|-------|--------|-------------|
| 2.8 | Status dropdown | `target.status` → Researching / Outreach active / Applied / Interviewing / Closed | ✅ **Researching** |
| 2.9 | App date button | `target.next_app_date` formatted, or **"Set app date"** | ✅ **Set app date** (no real date set) |
| 2.10 | App date editor | Date input + Save + Cancel | ❌ Hidden (not editing) |

**If NOT a target:** shows **"Add to targets"** button instead of 2.8–2.10. Capital One is a target.

**Target data that exists in DB but is NOT shown on detail page:**

| Field | Capital One |
|-------|-------------|
| `priority_score` | ❌ Not rendered |
| `tier` | ❌ Not rendered |
| `program_name` | ❌ Not rendered |

### 3. Application window hint

| # | Field | Source | Condition | Capital One |
|---|-------|--------|-----------|-------------|
| 3.1 | Window hint line | `target.app_window_text`, prefixed with *"Window hint:"* | Target exists + text set | ✅ *Window hint: Historically opens late summer to fall* |

### 4. Location facet chips

| # | Field | Source | Condition | Capital One |
|---|-------|--------|-----------|-------------|
| 4.1 | **All** chip | Clears `?location=` filter | `facets.length > 0` | ✅ Selected (green) |
| 4.2 | Office chips | `{label} ({count})` + map pin icon | Top 8 facets by default | ✅ See list below |
| 4.3 | **+N more** | Expands to show all facets | `facets.length > 8` | ✅ **+1 more** (9th location hidden) |
| 4.4 | **Manage offices** | Toggles office-management panel | Always in facet row | ✅ Right side of chip row |

**Capital One facets visible (8 shown + 1 hidden):**

1. New York, New York **(4)**
2. Mclean, Virginia **(3)**
3. Dallas, Texas **(1)**
4. London, England **(1)**
5. Plano, Texas **(1)**
6. San Francisco, California **(1)**
7. Seattle, Washington **(1)**
8. Remote **(2)**
9. *(hidden behind +1 more)* — one more location bucket

Sort order in code: real locations by count ↓, then Remote, then Unknown.

### 5. Manage offices panel *(collapsed by default)*

| # | Field | Capital One |
|---|-------|-------------|
| 5.1 | Explainer text about delete behavior | ❌ Panel closed |
| 5.2 | Add office: City, State, Country inputs + **Add office** | ❌ |
| 5.3 | List of existing offices with delete (×) | ❌ |
| 5.4 | `(manual)` tag on manually added offices | ❌ |

### 6. Main body — two columns (`lg`: 2/3 left · 1/3 right)

#### LEFT COLUMN — People

##### 6A. Current employees

| # | Field | Per-person source | Capital One |
|---|-------|-------------------|-------------|
| 6A.0 | Section title | `"Current employees"` + **(count)** | ✅ **Current employees (13)** |
| 6A.1 | Profile photo | `photo_url` or initials avatar | ✅ Photos on all 6 visible |
| 6A.2 | Name (link) | `name` → `/contacts/[id]` | ✅ e.g. Austin Gardner, Gregory Smith… |
| 6A.3 | Persona badge | `persona` → Recruiter / Product leader / etc. | ✅ Recruiter (×3), Product leader (×3 visible) |
| 6A.4 | BYU alum badge | `is_alum` | ❌ None on visible rows |
| 6A.5 | Outreach stage badge | Derived `stage` | ✅ All show **Not contacted** |
| 6A.6 | Title / headline | `roles[0].title` or `headline` | ✅ e.g. *Senior Talent Acquisition Partner…* |
| 6A.7 | Location on role | `roles[0].location_label` | ✅ e.g. London, England · New York, New York |
| 6A.8 | Remote suffix | `roles[0].workplace_type === "remote"` | ✅ Leon Bian shows **Remote** |
| 6A.9 | Multi-role indicator | `+N more role(s)` if multiple current roles | ❌ Not on visible rows |
| 6A.10 | Scrape staleness | `last_scraped_at` → *Data as of …* | ✅ *Data as of Jul 8, 2024* on rows |
| 6A.11 | Pattern-guess warning | Yellow triangle if email source is `pattern_guessed` | ❌ Not on visible rows |
| 6A.12 | Bounced label | If email bounced | ❌ Not on visible rows |
| 6A.13 | Email button | Mail icon → compose modal | ✅ Green mail button on each row |

**Sort order:** Recruiter → Product leader → Alum · Product → Product peer → Alum → alphabetical. Matches screenshot (recruiters first).

**Not shown per person (data exists):** email address text, `review_note`, `selection_reason`, `headline` when title exists, adjacency score (bench only).

**Capital One — 6 of 13 visible in screenshot** (7 more below fold):

| Name | Persona | Stage | Title snippet | Location |
|------|---------|-------|---------------|----------|
| Austin Gardner | Recruiter | Not contacted | *(title not fully visible)* | — |
| Gregory Smith | Recruiter | Not contacted | Sr TA Partner – Cyber Security/Technology | London, England |
| Jessica Harman | Recruiter | Not contacted | Principal Recruiter – Product, Sales… | New York, New York |
| Dhruv Agrawal | Product leader | Not contacted | Senior Product Manager | — |
| Leon Bian | Product leader | Not contacted | VP and Head of Product, AI & Data Security | Remote |
| Philomena L. | Product leader | Not contacted | Sr Director Product, GenAI Platform… | San Francisco, California |

##### 6B. Former employees

| # | Field | Capital One |
|---|-------|-------------|
| 6B.0 | Section title `"Former employees (N)"` | ❌ **Not in screenshot** (below fold) |
| 6B.1 | Same card fields as 6A | Expected **3 people** (16 header − 13 current = 3 former) |

##### 6C. Bench

| # | Field | Capital One |
|---|-------|-------------|
| 6C.0 | Collapsed toggle `▸ N more on the bench` | ❌ Not shown → **0 bench** |
| 6C.1 | Expanded: avatar, name, title, adjacency score, **Add to outreach** | ❌ |

#### RIGHT COLUMN — Recruiting notes *(§18 will add lens-aware grouping; Decision 5 card reverted in Phase 0)*

| # | Field | Source | Capital One |
|---|-------|--------|-------------|
| 6D.0 | Section heading | **Recruiting notes** + sticky-note icon | ✅ |
| 6D.1 | Note textarea | Placeholder: *What did you learn?…* | ✅ Empty |
| 6D.2 | Scope dropdown | **Company-wide** + each office from `offices` | ✅ **Company-wide** |
| 6D.3 | **+ Add** button | Disabled until text entered | ✅ Visible |
| 6D.4 | Empty state | *No notes yet — the best moment…* | ✅ |
| 6D.5 | Note cards (when notes exist) | Note text, date, location tag, delete | ❌ No notes yet |

**If not a target:** shows *"Add this company to your targets to log recruiting intel."* — not applicable here.

### Capital One — summary numbers

| Metric | Value | Where |
|--------|-------|-------|
| Header contact count | **16** | current + former, excludes bench |
| Current employees | **13** | Section heading |
| Former employees | **3** | Inferred (not visible) |
| Bench | **0** | No bench suffix in header |
| Location facets | **9** total, **8** visible + **+1 more** | Chip row |
| Recruiting notes | **0** | Empty state |
| Target status | **Researching** | Header dropdown |
| App date | **Not set** | "Set app date" |
| Window hint | **Historically opens late summer to fall** | Below header |

### Everything the page *can* show but Capital One did *not*

| Item | Why absent on Capital One |
|------|---------------------------|
| Bench count / section | No bench contacts |
| Former employees section | Below fold (3 people) |
| 7 more current employees | Below fold |
| Hidden 9th location facet | Behind **+1 more** |
| Manage offices panel | Collapsed |
| Priority / tier / program | Not implemented in UI |
| BYU badges | No alums in visible rows |
| Bounced / pattern-guess warnings | No matching email states |
| Saved recruiting notes | None logged yet |
| **Add to targets** button | Already a target |

### Data loaded but never rendered anywhere on this page

From `getCompanyDetail` / `CompanyPerson`:

- `company.universal_name`
- `target.priority_score`, `tier`, `program_name`
- `person.review_note`, `selection_reason`
- `person.headline` (when title exists)
- Email address string (only the compose button)
- Role start/end months, extra roles beyond the "+N more" indicator
- Full office list (only appears inside Manage offices or note dropdown)
- `company.logo_url` (still in query; not rendered after Decision 1)

---

## 17. Redesign decisions (applied)

| # | Decision | Rationale | Code |
|---|----------|-----------|------|
| 1 | **Remove company logo / initial from detail header** | Logos aren't scraped; the gray initial square added clutter without value | `careervine/src/app/companies/[id]/page.tsx` — logo block removed; header is name + metadata row only |
| 2 | **Back link hover (§16.1.1)** | Make navigation affordance obvious on a text-only control | `group` link: `hover:bg-surface-container-high`, text brightens, arrow `-translate-x-0.5` on hover |
| ~~3~~ | ~~LinkedIn wordmark~~ | **Reverted** — back to external-link + "LinkedIn" label (v1) | `ExternalLink` icon + text, `hover:text-primary` |
| 4 | **Remove company website/domain** | Not scraped, never edited, not needed for recruiting workflow | Dropped `companies.domain` (migration `20260709140000`); removed UI + types |
| 5 | ~~Target membership card (right column)~~ | **Superseded by §18** — card duplicated header, didn't support location-scoped targets | Revert before §18 implementation |

**Note:** `/companies` list and `/outreach` still show logo/initial until explicitly changed in a follow-up suggestion.

---

## 18. Target & intel redesign — company-wide vs location-scoped (planned)

**Status:** Plan only — **do not ship Decision 5 card**; revert sidebar target card before implementing this section.

**Problem:** Today's model treats "target" as a binary flag on the whole company. Recruiting reality is messier:

| What you actually do | What v1 supports |
|----------------------|------------------|
| Target **Capital One** as a company (any office, general APM hunt) | ✅ One `target_companies` row |
| Target **only Capital One · New York** (geo-specific program or referral path) | ❌ No location-scoped target |
| Log **company-wide** intel ("referrals go through employee portal") | ✅ Note with `location_id = null` |
| Log **NYC-only** intel ("NYC APM opens in August") | ⚠️ Tag exists, but no location target context |
| While viewing **NYC**, see company-wide notes **and** NYC notes together | ⚠️ Partial — filter hides company-wide notes when `?location=` is set (bug vs intent) |
| Know **at a glance** whether you're looking at a targeted company vs targeted office | ❌ Header controls only appear for company-level target |
| **Remove** a location target without deleting company-wide target | ❌ No remove; no location targets |

The screenshot feedback: the right column "On your targets" card **duplicates** the header without adding location semantics, and the note composer's "Company-wide" dropdown is disconnected from *what you're currently looking at* (the location facet).

---

### 18.1 Core concepts

Three independent layers, composed at render time:

```
┌─────────────────────────────────────────────────────────────┐
│  LENS (UI state)     Which office am I looking at?          │
│                      ?location=  or  All                     │
├─────────────────────────────────────────────────────────────┤
│  TARGET (persisted)  What am I actively recruiting?         │
│                      Company-wide and/or specific offices    │
├─────────────────────────────────────────────────────────────┤
│  INTEL (persisted)   What did I learn?                      │
│                      Company-wide notes + per-office notes   │
└─────────────────────────────────────────────────────────────┘
```

**Lens** = existing location facet chips (`?location=`). Drives people list, note visibility, and which target scope the header edits.

**Target** = a recruiting commitment with its own status, app date, priority, etc. Can exist at company level, office level, or both.

**Intel** = notes attached to the company's target *container*, scoped by `location_id` (null = company-wide).

---

### 18.2 Data model (proposed)

#### 18.2.1 Extend `target_companies` with optional `location_id`

```sql
ALTER TABLE target_companies
  ADD COLUMN location_id int REFERENCES locations(id) ON DELETE CASCADE;

-- Drop old uniqueness; replace with scoped uniqueness
ALTER TABLE target_companies DROP CONSTRAINT IF EXISTS target_companies_user_id_company_id_key;

CREATE UNIQUE INDEX target_companies_user_company_companywide
  ON target_companies (user_id, company_id)
  WHERE location_id IS NULL;

CREATE UNIQUE INDEX target_companies_user_company_location
  ON target_companies (user_id, company_id, location_id)
  WHERE location_id IS NOT NULL;
```

| Row | Meaning |
|-----|---------|
| `(user, Capital One, location_id = NULL)` | **Company-wide target** — recruiting applies to all offices |
| `(user, Capital One, location_id = NYC)` | **Location target** — only NYC is an active recruiting priority |
| Both rows | Valid — e.g. company-wide "researching" + NYC "outreach_active" |

**Migration:** All existing rows get `location_id = NULL` (company-wide). Zero data loss.

**Notes:** Keep `target_company_notes.target_company_id` pointing at the **company-wide** target row (the container). Notes continue to use `location_id` for scope. Alternative considered: notes FK to `companies` directly — rejected to avoid orphan notes when last target scope is removed; see §18.6.

**Container rule:** A company-wide `target_companies` row is the **intel container** whenever *any* target scope exists for that company. If user only targets NYC (no company-wide row), auto-create a minimal company-wide row as container OR add `company_id` to notes — **open question §18.9 Q1**.

#### 18.2.2 Query shape (`getCompanyDetail`)

Return scoped targets, not a single `target`:

```typescript
interface CompanyDetail {
  company: { ... };
  targets: {
    companyWide: TargetScope | null;      // location_id null
    byLocationId: Map<number, TargetScope>; // location_id → scope
  };
  activeScope: TargetScope | null;  // resolved from lens + targets
  notes: CompanyNote[];             // filtered per §18.4
  offices: CompanyOffice[];
  facets: LocationFacet[];
  // ... people unchanged
}

interface TargetScope {
  id: number;
  location_id: number | null;
  location_label: string | null;  // null = "Entire company"
  status: TargetStatus;
  priority_score: number | null;
  tier: string | null;
  program_name: string | null;
  app_window_text: string | null;
  next_app_date: string | null;
}
```

**`activeScope` resolution** (when user has facet `?location=123`):

1. If location target exists for `123` → **activeScope = location target** (header edits NYC)
2. Else if company-wide target exists → **activeScope = company-wide** (header shows inherited company status; optional "Track this office separately" action)
3. Else → **activeScope = null** (header shows add-target CTAs for this lens)

When lens is **All**:

1. If company-wide target exists → activeScope = company-wide
2. Else if exactly one location target exists → activeScope = that location (edge case)
3. Else if multiple location targets, no company-wide → activeScope = null, header shows **summary** ("3 offices targeted") + expand/manage

#### 18.2.3 Fix note filtering (bug)

Current code **filters out** company-wide notes when a location facet is active:

```704:704:careervine/src/lib/company-queries.ts
.filter((n) => !opts.locationKey || ... || n.location_id == null || String(n.location_id) === opts.locationKey)
```

The condition `n.location_id == null` in an OR chain means company-wide notes pass — **wait**, let me re-read:

```
!opts.locationKey || opts.locationKey === "remote" || opts.locationKey === "unknown" || n.location_id == null || String(n.location_id) === opts.locationKey
```

When locationKey is set to NYC id:
- Company-wide note (location_id null): `n.location_id == null` → **true** → included ✅
- NYC note: `String(n.location_id) === opts.locationKey` → included ✅  
- Dallas note: all false → **excluded** ✅

Actually the filtering might already work for notes! Let me re-read... When locationKey is "remote" or "unknown", all notes pass. When locationKey is a numeric id, company-wide passes via `n.location_id == null`.

So notes filtering might be correct already. The gap is really **target scope** and **UI** not reflecting location workflow.

I'll still document the intended behavior clearly in the plan.

---

### 18.3 UI redesign — header right cluster (primary)

**Remove** the sidebar target membership card (Decision 5). Target state lives in the **header right cluster only**, always visible, **lens-aware**.

#### A. Lens = All (no location filter)

```
┌──────────────────────────────────────────────────────────────────┐
│ Capital One                    ┌─ Target ─────────────────────┐  │
│ 16 contacts · LinkedIn         │ ● Entire company              │  │
│                                │   Researching ▾  Set app date │  │
│                                │   Priority 87 · APM Program   │  │
│                                │   [Manage targets…]           │  │
│                                └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Not targeted (company-wide):**

```
┌─ Not targeted ─────────────────────────────────────────────────┐
│  [ Target entire company ]   [ Target specific offices… ]      │
└────────────────────────────────────────────────────────────────┘
```

**Partial targeting** (e.g. NYC + SF targeted, no company-wide):

```
┌─ 2 offices targeted ───────────────────────────────────────────┐
│  New York · Researching    San Francisco · Outreach active     │
│  [ Target entire company ]   [ Manage offices… ]               │
└────────────────────────────────────────────────────────────────┘
```

#### B. Lens = specific office (e.g. New York)

```
┌─ Target · New York, New York ──────────────────────────────────┐
│  Outreach active ▾   Apps: Sep 15, 2026   [Remove office target]│
│  Company-wide: Researching (inherited) — [View all targets]     │
└─────────────────────────────────────────────────────────────────┘
```

**Office not targeted, company is:**

```
┌─ New York, New York ───────────────────────────────────────────┐
│  Company-wide target · Researching                              │
│  [ Target this office separately ]                              │
└─────────────────────────────────────────────────────────────────┘
```

**Neither targeted:**

```
┌─ New York, New York ───────────────────────────────────────────┐
│  Not targeted                                                   │
│  [ Target this office ]   [ Target entire company ]             │
└─────────────────────────────────────────────────────────────────┘
```

#### C. "Manage targets" panel (modal or inline expand)

Checklist of all offices + "Entire company" row:

| Scope | Status | App date | Actions |
|-------|--------|----------|---------|
| Entire company | Researching | — | Edit · Remove |
| New York, NY | Outreach active | Sep 15 | Edit · Remove |
| San Francisco, CA | — | — | **+ Add target** |
| Dallas, TX | — | — | — |

This is where bulk add/remove happens — not buried in a sidebar card.

---

### 18.4 UI redesign — recruiting notes (right column)

Notes column is **intel only** — no target membership card.

**Composer behavior:**

| Lens | Default note scope | Options in dropdown |
|------|-------------------|---------------------|
| All | Company-wide | Company-wide, any office |
| New York | New York | New York, Company-wide |

**Requires:** at least one target scope exists for this company (company-wide OR any location). If none, show empty state with same CTAs as header ("Target this office" / "Target entire company").

**Note list — lens = All:**

```
Recruiting notes
────────────────
Company-wide
  · Referrals through employee portal …     Jul 3
  · APM program is generalist …             Jul 1

New York, New York
  · NYC apps open late August …             Jul 5

San Francisco, California
  · Team is platform-focused …              Jun 28
```

**Note list — lens = New York:**

```
Recruiting notes · New York view
────────────────────────────────
Company-wide                          ← always visible, muted section label
  · Referrals through employee portal …

This office
  · NYC apps open late August …
  · Met recruiter Jessica — follow up …
```

Visual distinction: company-wide notes use a subtle "Company-wide" label; office notes use the office name or no label when in office lens.

**Sorting:** Newest first within each group; company-wide group above office group when viewing a location.

---

### 18.5 Location facets integration

Facets become **target-aware** without turning into a second navigation system:

| Facet chip | Visual when targeted |
|------------|---------------------|
| All | Dot if any target exists |
| New York (4) | Filled target icon or green ring if NYC is a location target; faint ring if only company-wide target |
| Remote / Unknown | Same rules if those buckets can be targeted (likely yes for Remote) |

Clicking a facet still filters people. Target state in header updates to match lens (§18.3 B).

Optional: long-press or ⋮ menu on facet → "Target this office" / "Remove target" for power users (Could-have).

---

### 18.6 Mutations (API / queries)

| Action | Behavior |
|--------|----------|
| `addTargetScope(companyId, locationId \| null)` | Insert scoped row; create company-wide container if first scope & notes need FK |
| `removeTargetScope(targetId)` | Delete one scope; cascade-delete **only** notes tagged to that `location_id` (confirm dialog); company-wide notes kept |
| `updateTargetScope(targetId, patch)` | Status, dates, priority — per scope |
| `addNote(companyId, text, locationId \| null)` | Requires ≥1 target scope; uses container target id |
| `deleteNote(noteId)` | Unchanged |

**Remove semantics:** Deleting company-wide target when location targets exist → prompt: "Remove company-wide target only, or all targets and notes?"

---

### 18.7 Downstream surfaces

| Surface | Change |
|---------|--------|
| **`/companies` list (Targets view)** | Show company if **any** scope targeted. Subtitle: "Entire company" or "New York + 1 more". Sort: use company-wide priority, else max across location scopes. |
| **`/outreach` queue** | Include company if any scope is active (not closed). Location filter optional future enhancement. |
| **Pipeline import** | Can seed company-wide target + `app_window_text` as today. Location targets remain manual. |
| **Home / recommendations** | Defer — use company-wide status first. |

---

### 18.8 User stories (new / revised)

| ID | Priority | Story |
|----|----------|-------|
| T1 | **M** | As a user, I want to **target an entire company** so general recruiting applies everywhere. |
| T2 | **M** | As a user, I want to **target a specific office** without targeting the whole company. |
| T3 | **M** | As a user, I want **separate status and app dates** per office when I've targeted multiple scopes. |
| T4 | **M** | As a user, when I filter to an office, I want the **header target controls** to reflect that office's target (or inherited company target). |
| T5 | **M** | As a user, I want **company-wide notes visible** when I'm viewing a specific office. |
| T6 | **M** | As a user, I want to **add office-specific notes** that don't clutter the company-wide view when I'm on All. |
| T7 | **M** | As a user, I want to **remove** a company-wide or office target without guessing. |
| T8 | **S** | As a user, I want facet chips to **indicate which offices are targeted**. |
| T9 | **S** | As a user, I want a **manage targets** panel listing all scopes in one place. |
| T10 | **C** | As a user, I want to target **Remote** as a scope when that's the relevant "office". |

**Supersedes:** C1.6 (add non-target → now scope-aware), C5.2 (note tagging → lens-defaulted), sidebar target card (Decision 5).

---

### 18.9 Open questions (need Dawson)

1. **Notes container when only location targets exist:** Auto-create a hidden company-wide `target_companies` row as FK container, or add `company_id` directly on notes? → **Discussing (see §18.12)**
2. **Simultaneous company-wide + location targets:** Can status **differ** (company Researching, NYC Outreach active)? → **Yes (confirmed)**
3. **Inherited vs separate UI:** When company-wide is targeted and you're on NYC without a location target, show inherited status only, or push user to create office target for office-specific dates? → **Discussing (see §18.12)**
4. **Deleting company-wide target** while location targets remain — allowed, or force remove all? → **Discussing (see §18.12)**
5. **Priority / tier / program:** Company-wide only, or per location scope? → **Discussing (see §18.12)**
6. **Implementation order:** Schema + query layer first, then header cluster, then notes grouping, then list page parity? → Default **yes** unless redirected

---

### 18.12 Design discussion — open questions 3–5 (Jul 2026)

#### Q2 confirmed: different status per scope

Company-wide and office targets are **independent recruiting states**. Example:

| Scope | Status | App date |
|-------|--------|----------|
| Entire company | Researching | — |
| New York | Outreach active | Sep 15 |
| San Francisco | — (not targeted) | — |

San Francisco facet: not targeted (unless company-wide inheritance applies for *display* — see below). NYC facet: edits NYC row only.

---

#### Q3 elaborated: inherited UI when company-wide exists but office doesn't

**Scenario:** Capital One is targeted company-wide as **Researching**. You click **New York** in the facet row. NYC has no separate location target.

The core tension: you're *looking at* an office, but your *recruiting commitment* might still be company-level. The UI must not trick you into changing the whole company when you meant to change NYC.

**Option A — Editable inheritance (simple, risky)**

Header on NYC lens shows the company-wide status dropdown and app date — edits write to the **company-wide row**.

| Pros | Cons |
|------|------|
| One status to maintain until you need splits | Changing status on NYC accidentally updates Capital One everywhere |
| Fewest clicks | Can't set NYC-specific app date without extra steps |
| Matches "I'm recruiting Capital One, NYC is just a filter" | Conflicts with confirmed Q2 (different status per scope) |

**Option B — Read-only inheritance + explicit fork (recommended default)**

Header on NYC lens:

```
Target · New York, New York
Company-wide: Researching          ← read-only, muted
[ Track this office separately ]   ← creates NYC location target
```

Until you fork:
- Status/app date controls are **not shown** for NYC (only the inherited line).
- Notes still work: company-wide notes + NYC-tagged notes.
- Facet chip: faint ring ("covered by company target, not office-specific").

After **Track this office separately**:
- Creates NYC row (default: copy company-wide status/date as starting point).
- Header becomes fully editable for NYC only.
- Company-wide row unchanged.

Small link: **Edit company-wide** — switches lens context to company scope (or opens manage panel) so you can change the parent without forking.

| Pros | Cons |
|------|------|
| Office-specific status is always intentional | One extra click when NYC really is different |
| No accidental whole-company edits | Two statuses to maintain once forked |
| Aligns with Q2 = yes | |

**Option C — Edit prompts fork (fast path, modal-heavy)**

Inherited status looks editable. On first change:

> Apply to entire company, or track New York separately?

| Pros | Cons |
|------|------|
| Handles both intents in one gesture | Modal on every first edit |
| | Harder to implement; easy to mis-click |

**Recommendation:** **Option B** as default. It matches your workflow (sometimes whole company, sometimes one office) and makes different statuses per scope a deliberate choice, not an accident.

**Open sub-question:** Should **app_window_text** (display-only hint) live company-wide only, or be overridable per office? Suggest **company-wide default**, optional per-office override when forked.

---

#### Q4 elaborated: removing company-wide target while office targets remain

**Scenario:** You have company-wide **Researching** + NYC **Outreach active** + 2 company-wide notes + 1 NYC note. You want to drop the company-wide *target* but keep pursuing NYC.

Three design philosophies:

**Philosophy 1 — Targets and notes are the same thing**

Deleting any target scope deletes its notes. Removing company-wide = lose company-wide notes.

| Pros | Cons |
|------|------|
| Simple | Loses intel you still want when narrowing to one office |

**Philosophy 2 — Notes are permanent company intel; targets are active scopes (recommended)**

- **Target** = "I'm actively recruiting this scope" (status, dates, list visibility).
- **Notes** = "What I learned" — persist unless you explicitly delete them.
- Removing a target scope removes **recruiting metadata** for that scope, not notes by default.

Removing **company-wide target** while NYC remains:

| What happens | Behavior |
|--------------|----------|
| Company-wide target row | Deleted or soft-cleared (`is_targeted = false`) |
| NYC target row | Unchanged |
| Company-wide notes | **Kept** — still visible on NYC lens and All |
| NYC notes | Unchanged |
| `/companies` list | Still shows Capital One (NYC target active) |
| Header on All lens | "1 office targeted" (not "Entire company") |

Removing **last** target scope (no office targets left):

```
Remove Capital One from your targets?
☐ Also delete 5 recruiting notes
[ Cancel ]  [ Remove target ]
```

Removing **one office target** (NYC only):

```
Remove New York target?
☐ Also delete 2 notes tagged to this office
Company-wide target and notes are not affected.
```

**Philosophy 3 — Block partial removal**

Must remove all office targets before company-wide, or vice versa.

| Pros | Cons |
|------|------|
| No ambiguous states | Annoying; doesn't match "I'm done with the company broadly but not NYC" |

**Recommendation:** **Philosophy 2**. It supports narrowing focus without losing research. It strongly pushes toward fixing **Q5** so notes aren't FK'd to a row you're about to delete.

---

#### Q5 discussed: priority, tier, program — where do they live?

These fields came from pipeline import (target spreadsheet). They mean different things:

| Field | Typical meaning | Example |
|-------|-----------------|---------|
| **priority_score** | How urgent / important right now | 87 |
| **tier** | Segment or geo bucket from your sheet | "Big Tech", "Utah/Silicon Slopes" |
| **program_name** | Which role/program you're chasing | "APM Program" |
| **next_app_date** | Real deadline you've confirmed | Sep 15 |
| **status** | Where you are in the process | Outreach active |

**Option A — Company-wide only**

Tier, program, priority live on the company-wide row. Location targets get **status + app date + window hint** only.

| Pros | Cons |
|------|------|
| Matches import (one row per company in sheet) | Can't rank NYC above Dallas on same company |
| List page stays one card per company | Same program assumed everywhere |

**Option B — Full per scope**

Every office target carries its own priority, tier, program.

| Pros | Cons |
|------|------|
| Maximum flexibility | Duplicate "Capital One · Big Tech · APM" on every office |
| | List page sorting gets ambiguous |

**Option C — Split by semantics (recommended)**

| Field | Scope | Rationale |
|-------|-------|-----------|
| **tier** | Company-wide only | Describes the employer segment, not the office |
| **program_name** | Company-wide default; optional office override | Usually one program per company; edge case: NYC = APM, London = grad scheme |
| **priority_score** | Per scope | NYC deadline sooner → higher priority on NYC row |
| **status, next_app_date, app_window_text** | Per scope | Already agreed for status; dates vary by office |

**List page (`/companies` Targets view) with Option C:**

- One card per company (not one card per office).
- Sort key: `max(priority_score)` across active scopes, then nearest `next_app_date`.
- Subtitle examples:
  - "Entire company · Researching"
  - "New York + San Francisco · Outreach active"
  - "New York · Outreach active" *(location-only target)*

**Option D — Company defaults with office overrides**

Company-wide sets priority/program/tier. Office targets inherit until you override priority or app date.

| Pros | Cons |
|------|------|
| Less typing | Inheritance rules to learn and implement |

**Recommendation:** Start with **Option C**. Tier/program are company attributes; priority and dates drive action per scope. Add office `program_name` override only if you hit a real case (Could-have).

---

#### Q1 / notes storage (plan item 1 + 5 combined)

If notes survive target removal (Philosophy 2), tying notes to `target_company_id` is awkward — deleting the row breaks the FK or orphans notes.

**Option A — Hidden container row**

Auto-insert `(user, company, location_id=NULL)` when first target or first note is created; mark `is_targeted=false` when no company-wide scope is active. Notes always FK to this row.

| Pros | Cons |
|------|------|
| Smallest schema delta | "Hidden row" is a hack; queries need care |
| | Container vs active target is easy to confuse |

**Option B — Notes FK to `(user_id, company_id)` (recommended with Philosophy 2)**

Add `company_id` (+ `user_id` for RLS) on `target_company_notes`. Deprecate `target_company_id` after migration.

| Pros | Cons |
|------|------|
| Notes = company intel, targets = scopes — clean split | Migration + RLS update |
| Removing targets never threatens notes | |
| Location-only targets work without fake rows | |

**Option C — Normalize: `target_scopes` child table**

One parent `target_companies (user, company)` always exists; scopes are children with location_id, status, dates. Notes FK to parent.

| Pros | Cons |
|------|------|
| Clean relational model | Bigger refactor than nullable `location_id` on one table |

**Recommendation:** **Option B** if we're committing to Philosophy 2. **Option A** only if we need the smallest possible Phase 1.

---

#### Decision summary (proposed defaults pending your sign-off)

| Question | Proposed default |
|----------|------------------|
| Q2 Different status per scope | **Yes** ✓ confirmed |
| Q3 Inherited UI | **Option B** — read-only inherited line + "Track this office separately" |
| Q4 Remove company-wide with offices left | **Allow** — keep office targets + all notes |
| Q5 Priority/tier/program | **Option C** — tier/program company-level; priority/dates per scope |
| Q1/Q5 Notes storage | **Option B** — notes on `company_id`, decoupled from target rows |

---

### 18.10 Implementation phases (suggested)

| Phase | Scope | Ship criteria |
|-------|-------|---------------|
| **0** | Revert Decision 5 sidebar card | Page back to header-only target + notes |
| **1** | Migration + `TargetScope` queries + `activeScope` resolution | Tests for scope CRUD and note visibility |
| **2** | Header right cluster redesign (§18.3) | Add/remove/edit targets at company and office lens |
| **3** | Notes column grouping (§18.4) | Lens-default composer; company-wide + office sections |
| **4** | Facet target indicators (§18.5) | Visual dots on targeted chips |
| **5** | `/companies` list parity (§18.7) | Targets view shows partial targeting |

Each phase is independently deployable behind existing route.

---

### 18.11 Wireframe (target state)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Companies                                                             │
├─────────────────────────────────────────────────────────────────────────┤
│ Capital One              ┌ Target · New York, NY ─────────────────────┐ │
│ 16 contacts · LinkedIn   │ Outreach active ▾   Apps: Sep 15, 2026    │ │
│                          │ Company-wide: Researching (inherited)      │ │
│                          │ [Manage targets…]                        │ │
│                          └──────────────────────────────────────────┘ │
│ Window hint: Historically opens late summer to fall (company-wide)    │
├─────────────────────────────────────────────────────────────────────────┤
│ [All] [● New York (4)] [McLean (3)] [San Francisco (1)] …  Manage offices│
├───────────────────────────────┬─────────────────────────────────────────┤
│ PEOPLE (NYC-filtered)         │ Recruiting notes · New York view        │
│ Current employees (4)         │ ── Company-wide ──                      │
│  …                            │  · Referrals through portal…            │
│                               │ ── This office ──                       │
│                               │  · NYC apps open late August…           │
│                               │  [composer → defaults to This office]   │
└───────────────────────────────┴─────────────────────────────────────────┘
```

*(Wireframe above assumes chip-based location nav — **superseded by §19** until location IA is chosen.)*

---

## 19. Location navigation redesign — beyond facet chips (planned)

**Status:** Blocking §18 open questions. Target/notes semantics depend on how **scope** (company-wide vs office) is chosen and displayed. Chips were built as a **people filter**; the new workflow needs **scope as primary navigation**.

**Prerequisite decision:** Pick a location IA pattern (§19.4) before finalizing §18.9 target/note rules.

---

### 19.1 Why chips fail for this workflow

Current implementation (`page.tsx` §4 in audit):

| Chip behavior | Fine for filtering people | Breaks for scope + targets |
|---------------|---------------------------|----------------------------|
| Horizontal wrap row | OK for 3–5 offices | Capital One already has 9 facets; Google-scale unusable |
| Top 8 + "+N more" | Hides data | Targeted office may be hidden behind "+1 more" |
| Same visual weight per chip | Neutral filter | Can't show **targeted** vs **not targeted** vs **inherited** |
| Label = `{city} ({count})` | People count only | No status, app date, note count, traction |
| Click toggles off (deselect) | Ambiguous | Scope should be explicit: *Entire company* OR *one office* |
| "Manage offices" at row end | Admin mixed with nav | Adding/removing offices is different from *working in* an office |
| Two data sources | `facets` from contacts; `offices` from `company_locations` | Manual office with 0 contacts doesn't appear as chip today |

**Conceptual mismatch:**

```
Today:     [ Company page ]  +  optional filter chips on people
Needed:    [ Company container ]  →  pick scope  →  everything else follows
                                      (header target, notes, people)
```

Scope is not a filter bolted onto a flat page — it's **where you are** in the recruiting workflow.

---

### 19.2 What each location row needs to communicate

When choosing/navigating scope, user should see at a glance:

| Signal | Example |
|--------|---------|
| **Name** | New York, New York |
| **People** | 4 contacts (not bench) |
| **Target state** | ● Office target · Outreach active — OR ○ Covered by company-wide · Researching — OR — Not targeted |
| **Timing** | Apps Sep 15 — or window hint snippet |
| **Intel** | 2 notes |
| **Traction** *(optional)* | 1 replied |

**Special scopes** (still first-class, not afterthought chips):

- **Entire company** — aggregate or company-wide target metadata
- **Remote** — people whose role is remote at this employer
- **Unknown** — incomplete location data; honest bucket
- **Offices with 0 contacts** — manual offices added for future notes/targeting (must appear in nav even if count = 0)

---

### 19.3 Unify `offices` + `facets` into one **scope list**

Backend/query change (conceptual):

```typescript
interface CompanyScope {
  key: string;              // "company" | location id | "remote" | "unknown"
  kind: "company" | "office" | "remote" | "unknown";
  label: string;
  location_id: number | null;
  contact_count: number;
  // From target layer (§18):
  target: TargetScope | null;           // direct target for this scope
  inherited_from_company: boolean;      // office covered by company-wide only
  note_count: number;
}
```

Build rule: start from `company_locations` (+ synthetic Remote/Unknown buckets from employment), merge contact counts from facets, attach target + note counts per scope. **Every navigable scope is one row** — no split between chip row and manage-offices panel.

URL: keep `?location=` for office scopes; omit param = **Entire company** (explicit, not "no filter").

---

### 19.4 UI pattern options

#### Option A — **Location rail** (left sidebar within page)

```
┌──────────┬────────────────────────────────┬─────────────┐
│ SCOPES   │ PEOPLE                         │ INTEL       │
│          │                                │             │
│ ● Entire │  (content for selected scope)  │  notes…     │
│   company│                                │             │
│ ○ New York│                               │             │
│   4 · ●  │                                │             │
│ ○ McLean │                                │             │
│   3 · ○  │                                │             │
│ + Add office                              │             │
└──────────┴────────────────────────────────┴─────────────┘
```

| Pros | Cons |
|------|------|
| Room for status, dates, note counts per row | Uses ~200px horizontal space |
| Scales to 20+ offices (scrollable list) | Mobile: collapses to drawer or bottom sheet |
| Scope feels like primary nav (Slack channels) | Three-column layout already busy |
| Target indicator per row naturally | |

**Best when:** You frequently switch offices during a session; many offices; per-office target state matters.

---

#### Option B — **Office table / card grid** (overview-first)

Default landing = **company overview** showing all scopes as rows or cards:

```
Entire company          Researching     16 contacts   3 notes   [Open]
New York, NY            Outreach active  4 contacts   2 notes   [Open]
McLean, VA              — not targeted   3 contacts   0 notes   [Target this office]
San Francisco, CA       — not targeted   1 contact    0 notes   [Open]
```

Click **Open** → drill into that scope's detail (people + notes + header target). Breadcrumb: `Capital One › New York`.

| Pros | Cons |
|------|------|
| All offices visible at once — no "+N more" | Extra click to reach people |
| Natural home for target actions per office | Two "modes" (overview vs detail) |
| Works well when company has many locations | Overview may feel redundant for 2-office companies |
| Zero-contact manual offices fit as rows | |

**Best when:** Office comparison is the main job ("which location am I pursuing?"); company-wide is one row among many.

---

#### Option C — **Header scope selector** (compact dropdown)

```
Capital One   Viewing: [ New York, NY ▾ ]     Target · Outreach active ▾
              ┌─────────────────────────────┐
              │ ● Entire company            │
              │ ● New York, NY  4  ● targeted│
              │ ○ McLean, VA    3            │
              │ ○ Remote        2            │
              │ + Add office…                 │
              └─────────────────────────────┘
```

People + notes fill the page below; no chip row.

| Pros | Cons |
|------|------|
| Minimal layout change from today | Scope hidden until dropdown opened |
| Scales to any office count + search | Less glanceable than rail or table |
| Clear "where am I?" in header | Metadata per office cramped in menu rows |
| Mobile-friendly | |

**Best when:** You usually stay in one scope per visit; switching is occasional.

---

#### Option D — **Tabs with overflow menu**

`[ Entire company ] [ New York (4) ] [ McLean (3) ] [ SF (1) ] [ ▾ More ]`

| Pros | Cons |
|------|------|
| Familiar pattern | Same overflow problem as chips at scale |
| One selected scope always visible | Tab bar can't show target status + dates |
| | Still horizontal space limited |

**Verdict:** Marginal upgrade over chips — **not recommended** as primary pattern for §18.

---

#### Option E — **Hybrid: rail + overview toggle**

- Default: Location rail (Option A) on desktop
- Rail top item: **Entire company**
- Button: **All offices overview** → expands Option B table inline (or modal) for compare/target management
- Mobile: scope selector (Option C)

| Pros | Cons |
|------|------|
| Daily nav = rail; planning = overview | Most complex to build |
| "Manage targets" lives in overview | |

**Best when:** You want both fast switching and compare-at-a-glance.

---

### 19.5 Recommended direction (for discussion)

**Lead with Option A (location rail) on desktop**, with **Option B overview** reachable via "All offices" / "Manage scopes" — not as the default daily view.

Rationale tied to your workflow:

1. **Scope drives target + notes** — rail keeps scope visible while scrolling people/intel.
2. **Per-office target state** needs more than a chip label — rail rows carry status + indicators.
3. **Company-wide vs office** is navigation, not deselecting a chip.
4. Capital One (9 locations) already outgrows chips; rail scrolls.
5. Header right cluster (§18) edits **active scope** — rail selection and header stay in sync.

**Mobile:** Header scope dropdown (Option C); rail becomes bottom sheet.

**Retire:** Facet chip row, toggle-to-deselect behavior, separate "Manage offices" link in chip row (move add/delete office into scope list footer or overview).

---

### 19.6 Page layout strawman (Option A + §18)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Companies                                                             │
│ Capital One · 16 contacts · LinkedIn                                    │
├────────────┬────────────────────────────────────────────┬───────────────┤
│ Scope      │  Target · New York, NY                     │ Recruiting    │
│            │  Outreach active ▾   Apps: Sep 15          │ notes         │
│ ● Entire   │  Company-wide: Researching (inherited)     │               │
│   company  ├────────────────────────────────────────────┤ ─ Company ─   │
│ ● New York │  Current employees (4)                     │  · …          │
│   4 · ●    │  …                                         │ ─ This office │
│ ○ McLean   │  Former …                                  │  · …          │
│   3        │  ▸ bench                                   │ [composer]    │
│ ○ Remote   │                                            │               │
│   2        │                                            │               │
│ ─────────  │                                            │               │
│ + Office   │                                            │               │
│ Manage…    │                                            │               │
└────────────┴────────────────────────────────────────────┴───────────────┘
```

- **Left rail** = scope navigation (replaces chips)
- **Top of center column** = target controls for active scope (replaces header-right-only)
- **Right column** = notes only (no target card)
- **Header** = company identity only (name, total contacts, LinkedIn)

This inverts today's hierarchy: company header is thin; **scope + target** sit above people.

---

### 19.7 Impact on §18 decisions

| §18 topic | Depends on location IA how? |
|-----------|----------------------------|
| Inherited company-wide target on office scope | Rail row shows ○ "via company" vs ● "office target" |
| Different status per scope | Rail + header edit the same selected row |
| Notes visible by scope | Composer + list already scoped to rail selection |
| Remove company-wide, keep offices | Overview/rail shows which rows remain targeted |
| `/companies` list | Unchanged — still company cards |

**Blocker:** Until Option A/B/C/E is chosen, don't implement §18 Phase 2+.

---

### 19.8 Open questions (location IA)

1. **Default scope on page load:** Entire company always, or last-visited scope (localStorage), or deep-link only?
2. **Single-office companies:** Hide rail and treat as company-only, or still show "Entire company" + one office row?
3. **Remote / Unknown:** Separate rail rows, or grouped under "Other"?
4. **Overview table (Option B):** Required for v1, or Phase 2 after rail ships?
5. **URL shape:** Stay on `/companies/[id]?location=` or nested route `/companies/[id]/offices/[key]`?

---

### 19.9 Revision log entry

| Date | Change |
|------|--------|
| 2026-07-09 | Added §19 — location navigation rethink; chips inadequate for scope-based targeting; four patterns + hybrid recommendation |

---

## 22. Outreach stage UX — pipeline preview (planned)

**Status:** Direction confirmed by Dawson (Jul 2026). Applies to **pipeline preview** (`/companies/[id]/preview/pipeline`) first; production company detail follows CAR-6 migration.

**Goal:** When the user is on **Outreach** (or has passed it), the recruiting panel shows **who they've actually reached** and **what happened** — without duplicating the contacts roster or surfacing people who haven't been touched yet.

### 22.1 Product decisions (confirmed)

| # | Decision |
|---|----------|
| 1 | **Not contacted** people do **not** appear in the outreach section — no list, no expand, no name chips. They remain visible only in the left contacts column. |
| 2 | Outreach is **not** tied to a specific program — no program banner, no per-program outreach slice. Outreach is **company/scope-wide** (matches §21 hybrid scope: company-wide cycle or office cycle, not researching `programs[]`). |
| 3 | **Manual offline logging** (coffee chat, LinkedIn DM, career fair, etc.) **is in scope for preview** — stored in preview localStorage alongside other cycle form state until CRM/outreach tables absorb it. |

### 22.2 What counts as "in outreach"

**Derived from CRM contact `stage`** (same source as contacts column):

| Include in outreach UI | Stages |
|------------------------|--------|
| Yes | `contacted`, `replied`, `call_scheduled`, `call_completed`, `referral` (and any future active-outreach stages) |
| No | `not_contacted`, `bounced` |

**Not contacted** may contribute to a **numeric stat only** on the collapsed line (e.g. "12 not yet contacted" as context) but **never** as roster rows in this section.

### 22.3 Collapsed outreach (progress ≥ Applied, user on a later step or outreach collapsed)

Single scannable line + optional name hints:

```
Outreach · 5 contacted · 2 replied · 1 call
Priya · replied · Marcus · contacted · +3 more
```

**Rules:**

- Aggregate counts by stage bucket: **contacted** (sent, no reply), **replied** (+ warmer stages), **calls** (scheduled + completed), **referral**.
- Show **3–5 prioritized names** (replied / calls / referral first, then contacted), then **"+N more"** if needed.
- **No** not-contacted names.
- **No** program label.
- Manual log entries: if any exist, append a short suffix — e.g. **"· 2 offline notes"** — or surface the most recent log one-liner when no CRM outreach contacts exist yet.

### 22.4 Expanded outreach (Outreach step selected)

**Layout (top → bottom):**

1. **Stats strip** — same aggregates as collapsed (compact pills or inline text).
2. **Active conversations** — contacts in `replied`, call stages, `referral` (grouped or single list with stage badge).
3. **Reached out** — contacts in `contacted` only (awaiting reply).
4. **Offline log** — manual entries (see §22.5); newest first.
5. **Footer link** — "View all in Outreach →" to `/outreach` (filtered by company when query param exists).

**Explicitly out of scope in this panel:**

- Full contacts list (left column owns that).
- Not-contacted roster.
- Program name / apps-open / job-potential from Researching.
- Inline email compose (link out to outreach or contact detail).

### 22.5 Manual offline log (preview storage)

**Purpose:** Capture touchpoints that aren't reflected in CRM stage yet (in-person coffee, LinkedIn, recruiter booth, etc.).

**Preview data shape** (per cycle scope in `pipeline-preview-storage`):

```ts
outreach: {
  log: Array<{
    id: string;
    body: string;              // free text — what happened
    contactId?: number;      // optional link to company contact
    channel?: "linkedin" | "email" | "phone" | "in_person" | "other";
    occurredOn?: string;       // ISO date (optional)
  }>;
}
```

**UI pattern:** Match researching notes — left-accent rows, blur-to-save composer, delete per row. Optional contact picker limited to **outreach-eligible** contacts (same include list as §22.2); picker not required for a log line.

**Collapsed behavior:** Count or latest one-liner in summary (§22.3).

**Production path (later):** Sync to outreach activities / meeting notes tables; not blocking preview.

### 22.6 Relationship to other surfaces

| Surface | Role |
|---------|------|
| **Contacts column (left)** | Full roster including not contacted; primary place to add people and set stage. |
| **Outreach section (right, Outreach step)** | Subset + narrative — who you've touched, warmth, offline log. |
| **`/outreach` global page** | Cross-company queue; deep link from footer. |
| **Researching programs** | Separate concern — apps open / job potential per program; **no** outreach coupling. |

### 22.7 Implementation slices (pipeline preview)

1. **Helpers** — `getOutreachContacts(contacts)`, stage buckets, collapsed summary string, name prioritization.
2. **Storage** — extend `CycleFormState` with `outreach.log`; default `[]`; migrate missing key on read.
3. **`OutreachSummary`** — collapsed read-only block in `StageSummary` when `progressStage` past Outreach or Outreach collapsed.
4. **`OutreachPanel`** — expanded fields in `StageFormFields` when `expandedStage === "outreach"`.
5. **`OutreachOfflineLog`** — composer + list component (reuse notes visual language).
6. **Tests** — bucket/summary helpers; storage normalization; no not-contacted in derived lists.

### 22.8 Open questions

1. **Collapsed stat for not contacted:** Show "N not yet contacted" on the outreach line, or omit entirely? (Default: **omit** — user said not contacted should not appear; stats line can stay positive-only.)
2. **Scope filter:** Office cycle shows outreach contacts filtered to that office only, or all company contacts? (Default: **match active scope** — same as contacts column filter.)
3. **Stage changes:** Outreach panel read-only for CRM stages in preview, or allow quick stage bump? (Default: **read-only in preview** — edit in contacts column or `/outreach`.)

### 22.9 Revision log entry

| Date | Change |
|------|--------|
| 2026-07-09 | §22 outreach plan — not-contacted excluded from section; no program tie-in; manual offline log in preview scope |
| 2026-07-09 | Added §23 — Applied stage multi-job applications + PDF resume/cover letter uploads (preview IndexedDB) |

---

## 23. Applied stage — multi-job applications & PDF uploads (planned)

**Status:** Implemented in pipeline preview (Jul 2026). Production storage TBD.

**Goal:** Users often apply to **multiple roles** at one company (different programs, offices, or re-applications). The Applied step should track each submission independently with **resume and cover letter PDFs** attached per application.

### 23.1 Product decisions

| # | Decision |
|---|----------|
| 1 | **Multiple applications** per cycle — same card pattern as researching programs (`applications[]`). |
| 2 | Each application has: **job/role**, **location**, **date applied**, **resume PDF**, **cover letter PDF**. |
| 3 | **PDF only** for documents in preview; max **5 MB** per file. |
| 4 | Office scope: location is **implicit** (active office); company scope: location is **editable per application**. |

### 23.2 Preview data shape

```ts
applied: {
  applications: Array<{
    id: string;
    jobTitle: string;
    location: string;
    dateApplied: string;       // ISO date (YYYY-MM-DD)
    resumeFileId: string | null;
    coverLetterFileId: string | null;
  }>;
}
```

**File blobs** stored in **IndexedDB** (`cv-pipeline-preview-files`), keyed by `companyId:fileId`. Cycle state in localStorage holds only file IDs — avoids quota issues.

**Legacy migration:** flat `resume` / `coverLetter` / `dateApplied` / `locations[]` → one application row per location (or one row if only date/text). Text link fields are not carried forward (PDF upload replaces them).

### 23.3 UI

| State | Behavior |
|-------|----------|
| **Expanded** | `AppliedApplicationsEditor` — stacked cards, add/remove, PDF upload per doc |
| **Collapsed** | One summary line per application: `Role · Location · Date · Resume + Cover letter` |

### 23.4 Production path (later)

- Supabase Storage bucket for application documents
- `job_applications` table scoped to `target_companies` row (company-wide or office)
- Same multi-row model; migrate preview IndexedDB files on first production sync

### 23.5 Revision log entry

| Date | Change |
|------|--------|
| 2026-07-09 | §23 — multi-job applied + PDF uploads in pipeline preview |

---

## 24. Implementation plan — promote pipeline preview to production (confirmed)

**Status:** Approved by Dawson 2026-07-09. The pipeline preview **is** the company page. All other PoC layouts die. localStorage/IndexedDB PoC data is **discarded** (fresh start seeded from `target_companies`). Full feature parity with the old page: email compose, bench expand + promote, manage offices.

### 24.1 Schema (one migration)

Follows §18.2.1 + §21.4 + §23.4:

1. **`target_companies` becomes the scope table** — add `location_id int REFERENCES locations(id) ON DELETE CASCADE` (NULL = company-wide), add `is_targeted boolean NOT NULL DEFAULT true`, add `active_cycle int NOT NULL DEFAULT 1`; drop the `(user_id, company_id)` unique constraint; add partial unique indexes (company-wide where `location_id IS NULL`; `(user_id, company_id, location_id)` where NOT NULL). `is_targeted` is a **soft flag** so un-targeting never destroys cycle data (Philosophy 2, §18.12 Q4).
2. **`pipeline_cycles`** — `target_company_id` FK cascade, `cycle_number`, `selected_stage` (same enum as status), `declined_next_cycle`, unique `(target_company_id, cycle_number)`.
3. **Cycle children** (uuid PKs client-generated so upserts work; all with `position` for ordering): `pipeline_programs` (name, apps_open, job_potential), `pipeline_notes` (body), `pipeline_applications` (job_title, location, date_applied, resume_path/name/size, cover_path/name/size), `pipeline_interview_rounds` (interview_date, interviewer, questions).
4. **RLS** — ownership chained through `target_companies.user_id = auth.uid()` (same pattern as `target_company_notes`).
5. **RPCs** — `save_pipeline_cycle(target_company_id, cycle_number, payload jsonb)` upserts the cycle + syncs all four child tables atomically; `delete_pipeline_cycle(...)` deletes and renumbers higher cycles. Avoids 8 debounced client queries per save and rule-17 CAS traps.
6. **Storage** — private bucket `application-files` (5 MB limit, PDF only), paths `{user_id}/{uuid}.pdf`, per-user-folder RLS policies.

### 24.2 Data layer

- New `src/lib/pipeline-queries.ts`: `loadPipelineState` (scope rows + cycles + children → the existing state shape), `ensureScopeTarget` / `setScopeTargeted` (soft toggle), `saveCycle` (RPC), `deleteCycle` (RPC), `setActiveCycle`, file upload/signed-URL/delete helpers.
- `pipeline-preview-storage.ts` → rename to `pipeline-state.ts`: **keep** types, normalizers, patch helpers, default builders; **drop** localStorage load/save, versioning, and legacy-shape migration paths (PoC data is discarded).
- `company-location-preview.ts`: remove `mockTargetMeta` + injected sample note; office `isTargeted`/`status` come from real scope rows. Keep the facet-key convention (`String(location_id)`).
- Scope keys map: `"all"` ↔ company-wide row (`location_id NULL`); office key ↔ row with that `location_id`. Remote/Unknown buckets stay non-targetable.
- Status sync: changing the active cycle's stage writes `target_companies.status` on that scope row, so `/companies` list + `/outreach` stay accurate.
- Autosave: `usePipelineAutosave` hook — same reducer state as preview, dirty-tracking per (scope, cycle), ~800 ms debounce, flush on unload; small Saved/Saving indicator. Targeting toggles + active-cycle changes write immediately.

### 24.3 UI

- `/companies/[id]/page.tsx` renders the pipeline layout (Navigation + back link + PipelineLayout) wired to the DB. Scope selection moves to `?location=` URL param (shareable, replaces localStorage `scope`); search + mainTab are transient component state.
- Parity ports from the old page, restyled to the pipeline aesthetic: **email compose** (real Mail button → compose modal, bounce block + pattern-guess warning), **bench** (expandable list, adjacency score, promote to outreach), **manage offices** (add/delete panel near the Location dropdown).
- `pipeline-pdf-upload.tsx` re-targeted from IndexedDB to Supabase Storage (same UI; signed URL on view).
- **Delete**: all six `/preview` routes, `stack/cards/accordion/split/tabs` layouts, `preview-page.tsx`, `PreviewBanner`/`CompanyHeaderThin` (`shared.tsx`), `PREVIEW_VARIANTS`, `pipeline-preview-files.ts`, the old page body, and the "Preview pipeline layout →" links.

### 24.4 Downstream parity

- `getCompanies` (targets view): a company is targeted if **any** scope row has `is_targeted`; card fields prefer the company-wide row, else derived from office rows.
- `addTargetCompany` / MCP `get_company` path: pin to company-wide scope (`location_id IS NULL`) explicitly; verify the careervine MCP server queries still behave.
- `removeTargetCompany` stays a hard delete (list-page flow); the pipeline page uses the soft toggle.

### 24.5 Tests & verification

- Retarget existing pipeline state tests to `pipeline-state.ts`; delete localStorage/legacy-migration tests; add tests for cycle→payload mapping, scope-key mapping, and targets-view derivation.
- `npm run test` + `npm run build` from `careervine/`; migration dry-run then `supabase db push`.
- Browser verification (high-risk restructure): full loop on a real company — target office, edit each stage, upload PDF, reload, cross-scope isolation.

### 24.6 Delivery

Work continues on the existing CAR-6 branch; single PR to `main` (migration + cross-cutting ⇒ PR path per rule 19). Slices: (1) migration, (2) data layer + tests, (3) page swap + autosave, (4) parity ports + deletions, (5) downstream parity + verification.

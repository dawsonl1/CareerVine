# CAR-10 — Companies list page redesign

Branch: `dawson/companies-page-redesign-b6733f` (no CAR in name → Linear handled manually).

## Problem (Dawson, 2026-07-11)

The `/companies` list is "poorly laid out and designed, and doesn't give
helpful information about each company." For a relationship-driven job
search the user opens this page asking: **what do I do next, where do I
have an in, and how's my pipeline?** The current page answers none well:

- Flat, undifferentiated list — an interviewing company looks identical
  to one merely researched, just re-sorted.
- Shows **counts, not insight** — "8 contacts" hides the thing that
  matters here: is one a BYU alum? a recruiter? has anyone replied?
- Never says **what to do** — you must open each company to find out.
  Raw `priority: 72` has no meaning.
- Deadlines are buried in a text fragment.
- Default view is a **dump**: `in_play` = targets ∪ any company with a
  current contact, so every imported `active` contact drags its employer
  onto the list.

Two explicit design notes from Dawson on the proposal mockup:
1. The pipeline snapshot bar "looks too much like a filter," which makes
   the My companies / All toggle stop reading as the real control.
2. Dislikes that the list auto-loads companies that aren't targeted or
   have no contacts. Wants it cleaner / more intentional.

## Design

### 1. Focused default view (note 2)
New scope `pursuing` = **targeted ∪ has a current `prospect` contact**.
Drops companies whose only tie is an `active` (imported) contact. Keeps
CAR-89's win (prospect companies show). Targeted-but-contactless companies
stay (intentional targets) but sink to the bottom via the new sort.
`in_play` stays defined (still used by tests / available) but the page
switches to `pursuing`. `targets`/`all` untouched (outreach + MCP).

### 2. "Who you know" = quality, not counts
Enrich `CompanySummary` for the pursuing set (bounded, batched):
- `alum_count` — BYU alumni among current non-bench contacts
  (`verified_school` != none/null OR `contact_schools` BYU match).
- `recruiter_count` — `persona = 'recruiter'`.
- `lead_contact_name` — the name to drop into the next-action line
  (highest-traction current contact, else best warm lead, alum-first).
Card shows `2 BYU alumni · 1 recruiter` instead of `8 contacts`.

### 3. Next-action line (the intelligence)
Pure `deriveNextAction(company, now)` → `{ text, icon, tone, rank }`.
Priority ladder: interviewing → deadline soon → replied → call scheduled →
referral → applied follow-up → contacted follow-up → warm-untouched
("Reach out to your alum") → no-contacts ("Find people who work here") →
closed. `rank` drives the default **"What's next"** sort.

### 4. Pipeline summary as info, not control (note 1)
Slim **funnel readout** (segmented bar + inline stage counts), visually a
chart — not pills, not clickable toggles. Sits below the header. The
My companies / All segmented toggle stays the one obvious view control;
filter chips stay clearly filters (existing checkmark style). Three
distinct visual treatments so nothing competes.

## Files
- `src/lib/company-queries.ts` — `pursuing` scope, prospect tracking,
  enrichment (alum/recruiter/lead name).
- `src/lib/company-next-action.ts` (new) — `deriveNextAction`, ranks,
  pipeline-summary counts. Pure, unit-tested.
- `src/app/companies/page.tsx` — view semantics, funnel summary, sort.
- `src/components/companies/company-card.tsx` (new) — the rich card.
- `src/components/companies/company-filter-bar.tsx` — hierarchy tweak.
- Tests: extend `company-scope.test.ts`; new `company-next-action.test.ts`.

## Verification
- `npm run test` + `npm run build` from `careervine/`.
- Browser preview (high-risk layout, rule 13): render `/companies`,
  screenshot the redesigned list.
- Docs check (rule 34): `public/docs/index.html` companies copy.
- No migration. No new env.

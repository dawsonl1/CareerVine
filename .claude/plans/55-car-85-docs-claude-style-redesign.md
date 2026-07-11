# CAR-85: Redesign docs.careervine.app to a Claude-Code-docs-style layout

## Goal
Rebuild `careervine/public/docs/index.html` so the **organization and feel** mirror
the Claude Code docs (code.claude.com/docs/en/overview), while **keeping the content
framed around the jobs** a user is doing (from CAR-83). Same 8 jobs, same copy, new shell.

## Reference: what the Claude Code docs do
- Three-column docs shell: grouped **left sidebar nav**, serif-headed **center column**,
  right **"On this page" TOC**.
- Top bar: brand mark + wordmark, horizontal top-level nav, theme toggle, CTA.
- Body patterns: small-caps eyebrow labels, serif H1/H2, card grids, an **accordion**
  ("What you can do"), an **"I want to..." table**, a **"Next steps"** link block,
  hoverable per-heading anchor links.
- Warm cream neutral palette + serif headings (CareerVine already shares this DNA).

## Target structure (single self-contained HTML file)
1. **Top bar** (sticky): CareerVine vine mark + wordmark; right side theme toggle +
   "Open CareerVine" CTA to careervine.app. Mobile: hamburger toggles the sidebar.
2. **Left sidebar** (sticky, scrollable): the 8 jobs grouped:
   - *Getting started*: Overview, Job 01 Start with a network
   - *Work your network*: Job 02 Who to contact, Job 03 Write outreach,
     Job 04 Follow up, Job 05 Remember conversations
   - *Run your search*: Job 06 Job-search pipeline
   - *Power & trust*: Job 07 AI assistant, Job 08 Your data & keys
   Active item highlighted with a rounded pill (scroll-synced).
3. **Center column** (~760px): hero/overview at top, then the 8 job sections.
   - Overview borrows Claude's overview shape: intro + an **accordion** summarizing the
     8 jobs (each row links down) + a compact **"I want to..." table** + **Next steps**.
   - Each job keeps its eyebrow (`Job 0N`), serif H2, intro, sub-groups, and card grids
     verbatim from the current page.
   - Surface/where-it-lives tags kept (Extension, AI, Auto-sync, Guardrail, etc.).
4. **Right TOC** (sticky, >=1200px only): "On this page" listing the active job's
   sub-group headings; scroll-synced. Hidden on narrow.

## Preserve
- All 8 jobs and their copy (well-written, already rule-35 clean).
- Green Material-derived palette + light/dark toggle.
- The 27 MCP tool cards, stepper for onboarding, callouts.

## Responsive
- >=1200px: 3 columns. 900-1200px: sidebar + content (TOC hidden).
- <900px: single column; sidebar becomes a slide-in drawer via hamburger.

## Verify
- `next build` not required (static file), but visually verify in preview browser at
  desktop + mobile widths, light + dark. High-risk layout change -> browser check warranted.
- Confirm no em dashes introduced (rule 35).
- Update docs page is itself the deliverable; no app behavior changes -> no other doc drift.

## Process notes
- Branch `dawson/careervine-docs-redesign-5ce9db` is not CAR-named, so Linear hooks
  won't bind; handle status/PR/Done flips manually via MCP.

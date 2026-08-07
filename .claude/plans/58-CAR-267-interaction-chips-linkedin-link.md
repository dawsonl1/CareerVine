# CAR-267: Per-type conversation chips + LinkedIn link on company-page contact rows

## Problem

Reported on Lucid Software (company 1437) / Spencer Hintze (contact 1097):

1. **The stage chip lies about what happened.** Spencer's only logged conversation is a
   `meetings` row with `meeting_type: "text"` ("LinkedIn chat", 2026-06-29), but his card
   on the company page shows a **"Call done"** chip — `STAGE_LABELS[call_done]` rendered
   straight off the derived stage. This is the same defect CAR-257 fixed on the company
   next-action pill ("Follow up with Spencer after your call") and on the companies-list
   traction chip noun, one surface over. Dawson's ask: kill the generic "Call done" chip
   and show **individual, specific chips per conversation type**.
2. **No working LinkedIn affordance on the contact row.** The collapsed row shows
   email / location / current company but no LinkedIn link even when `linkedin_url` is on
   file (LinkedIn is only reachable through the expanded quick-preview). Verified both
   Spencer's and the company's `linkedin_url` in prod are valid absolute URLs, and both
   existing anchors (page header, expanded pill) are real `<a href target="_blank">`
   elements in source — the missing affordance is the collapsed row itself.

## Where the data comes from

`getContactStages` (company-queries.ts) already knows the conversation kind behind the
call stages (CAR-257) but keeps only the LATEST past kind / SOONEST upcoming kind plus an
`allCalls` flag. Every affected surface consumes `CompanyPerson`, which today carries only
`stage`:

- `pipeline-layout.tsx` ContactRow chip (line ~732) — the reported chip
- `pipeline-layout.tsx` recruiting-panel outreach lines (~291, ~436): "· Call done"
- `app/outreach/page.tsx` (~479): same chip on the outreach page
- `person-modal.tsx` (~103): stage label in the header

## Changes

1. **stage-derivation.ts** — add `CONVERSATION_KIND_CHIP_LABELS`: per-`ConversationKind`
   chip labels for both call stages.
   - past: call → "Call done", career-fair → "Career fair", networking → "Networking
     event", text → "Texted", other → "Conversation"
   - upcoming: call → "Call scheduled", career-fair → "Career fair scheduled",
     networking → "Networking event scheduled", text/other → "Conversation scheduled"
     (CAR-257 precedent: you do not schedule a text exchange, so a mislabel collapses to
     the one word that cannot be wrong)
   - add pure helper `stageChipLabels(stage, conversations)` → `string[]`: the specific
     chip labels for call stages (one per distinct kind), `[STAGE_LABELS[stage]]` for
     everything else, and the stage label as fallback when a call stage has no
     conversation record behind it (pure `stage_override` — the override asserts "call
     done" with no event to describe).
2. **company-queries.ts** — `ConversationSummary` gains `kinds: ConversationKind[]`
   (distinct, most-recent-first for past / soonest-first for upcoming; `kind` stays the
   first element, `allCalls` unchanged). `CompanyPerson` gains
   `conversations: ContactStage["conversations"]`, populated in `getCompanyDetail` from
   the stages map (both rosters; `{past: null, upcoming: null}` when underived).
3. **Render sites** — replace the four `STAGE_LABELS[stage]` reads with
   `stageChipLabels(...)`: ContactRow renders one chip per label (existing
   `STAGE_STYLES[stage]` styling per chip), the two recruiting-panel lines join labels
   with " · ", outreach page maps chips, person modal joins.
4. **ContactRow LinkedIn link** — add a LinkedIn anchor to the collapsed row's xl detail
   column (ExternalLink icon + "LinkedIn", `stopPropagation`, `target="_blank"`), matching
   the contacts-list card pattern. Expanded pill and header anchor stay.

## Verification

- Unit: label maps + `stageChipLabels` (call/text/multi-kind/override-fallback);
  `getContactStages` distinct-kinds ordering exercised through existing traction-chip
  test module patterns.
- E2E (`e2e/interaction-chips-linkedin.spec.ts`): seed a tenant contact at a company with
  a past `meetings` row of `meeting_type: "text"` + `linkedin_url` on both contact and
  company; assert the row shows "Texted" and does NOT show "Call done"; click-probe all
  three LinkedIn anchors (header, collapsed row, expanded pill) and assert each opens a
  popup to the right URL — this settles empirically whether any of them was dead.
- `npm run test`, `npm run check:conventions`, `npm run test:integration` before the PR.

## Out of scope

- The companies-LIST traction chip and next-action pill (already kind-aware via CAR-257).
- MCP dossier output (`outreach_stage: call_done` is API vocabulary, not a UI chip).
- The pipeline board's stage columns (stages themselves, not conversation claims).

# CAR-83 — Restructure docs.careervine.app to be solution/job-oriented

## Goal

Rework the public docs page (`careervine/public/docs/index.html`) so it is organized around the **jobs a user is doing** rather than by the five technical "surfaces" (Web App, Intelligence, Extension, MCP, Platform). Solution-oriented, not feature-oriented. No em dashes (complies with rule 35).

## Approach

1. **Audit first.** Four read-only agents audited the code behind every claim on the old page across all five surfaces, so the rewrite reflects real behavior (rule 34). Result: every verified claim was TRUE, so this is a reorganization, not a fact fix. Corrections folded in anyway (transcript formats, opt-in discovery, server-side extension parse, stage-concept split, onboarding decline path).

2. **Reframe the information architecture.** Surfaces stop being the top-level axis and become small tags on individual capabilities. The page becomes 8 jobs, in the order a job-seeker hits them:
   1. Start with a network, not a blank page
   2. Always know who to reach out to next
   3. Write outreach that sounds like you
   4. Follow up relentlessly, hands-free
   5. Remember every conversation
   6. Run your job search like a pipeline
   7. Hand your whole network to an AI assistant
   8. Your data and costs stay yours

3. **Benefit-first voice.** Each section leads with the outcome, then the capabilities that deliver it.

4. **Drop operator-only content.** Admin control plane, bundle publishing, and IB recruiting pipeline internals are removed from the public page.

5. **Preserve the design system.** CSS and JS are unchanged byte-for-byte; only content was rewritten. Nav anchors updated to the 8 new section ids.

## Verification

- Structural checks: 8 nav links map 1:1 to 8 section ids, 27 MCP tool cards intact, all HTML tags balanced, 0 em dashes.
- Design system untouched, so rendering is unchanged from the proven original.

## Scope notes

- Docs-only change. The separately-spawned `email-send.ts` docstring fix is tracked and handled on its own branch, not here.

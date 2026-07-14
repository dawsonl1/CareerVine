# CAR-127: Outreach Drafts tab (expand, edit, cancel)

## Goal

Free-tier Outreach users can browse auto-saved drafts in a Drafts tab: expand to read the body, edit in compose (same draft id), or cancel (delete).

## Approach

1. Load drafts from `GET /api/gmail/drafts`; refresh on `careervine:drafts-changed`
2. Add Drafts tab on `OutreachShell` (count like Sent / Scheduled / Follow-ups)
3. Resume draft id via compose `openCompose({ draftId })` so edit does not drop the row
4. Tests + docs touch for Free Outreach copy

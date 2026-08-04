# CAR-127: Outreach Drafts tab (expand, edit, cancel) + recipient context

## Goal

Free-tier Outreach users can browse auto-saved drafts in a Drafts tab: expand to read the body, edit in compose (same draft id), or cancel (delete).

Every Outreach email row (Sent, Drafts, Scheduled, Follow-ups) also shows the contact, current role, company, and office when known, with links to the contact and company pages.

## Approach

1. Load drafts from `GET /api/gmail/drafts`; refresh on `careervine:drafts-changed`
2. Add Drafts tab on `OutreachShell` (count like Sent / Scheduled / Follow-ups)
3. Resume draft id via compose `openCompose({ draftId })` so edit does not drop the row
4. Batch-enrich `/api/gmail/inbox` + drafts with `contactDetails` from current `contact_companies`
5. `RecipientMeta` UI: linked contact + title + linked company + office
6. Tests + docs touch for Free Outreach copy

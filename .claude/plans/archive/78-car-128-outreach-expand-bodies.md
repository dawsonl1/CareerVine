# CAR-128: Outreach expand full bodies (all tabs)

## Problem (confirmed in code)

1. **Scheduled** and **Follow-ups**: UI never renders `body_html`. Scheduled has no expand at all; follow-up steps show subject/status only.
2. **Sent** and **Drafts**: expand works, but the body container uses `max-h-[28rem] overflow-y-auto`, so long messages are clipped inside a nested scroll area and feel incomplete.

Data is already present in the inbox/drafts payloads (`scheduled_emails.body_html`, `email_follow_up_messages.body_html`, sent/draft `body_html`). This is a UI gap, not a missing API/schema.

## Approach

1. Shared `EmailBodyHtml` renderer (DOMPurify) with **no height clip**; page scroll shows the full message.
2. **Scheduled**: row expand/collapse like Drafts; expanded pane shows full body.
3. **Follow-ups**: each open step expands to show that step's full body (chevron on the step).
4. **Sent / Drafts**: keep expand; swap clipped body for the shared unclipped renderer.
5. Tests covering expand on Scheduled + Follow-up step body + unclipped Sent/Drafts.
6. Docs copy touch for Free Outreach body reading.

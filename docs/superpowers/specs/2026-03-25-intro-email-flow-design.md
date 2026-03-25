# Smart Intro Email Flow — Design Spec

## Problem

A networking student adds contacts from a career fair or LinkedIn. When they click the email button in CareerVine, they get a blank compose modal. They don't know what to write, so they close the tab. The highest-value moment in the app has the most friction.

Even if they do send an email and don't hear back, they give up. There's no system for follow-up persistence.

## Solution

A guided intro email flow inside the existing compose modal that:

1. Gathers context through a few quick questions
2. Uses AI to draft a personalized intro email
3. After the student approves the intro, generates 3 follow-up reply emails
4. Schedules follow-ups automatically with reply-cancellation detection

## Scope

- **Only** for first outreach to a contact (intro emails)
- **Only** triggers from the intro button (envelope icon on Recently Added contacts, or "Draft an introduction email" in compose)
- All other emails continue working exactly as they do now

## User Flow

### Phase 1: Context Gathering

When the student clicks the intro button, the compose modal opens immediately with `To:` pre-filled. Instead of a blank body, the body area shows context questions.

**Question 1 — "How do you know [Name]?"**

Quick-select chips:
- Career fair
- LinkedIn
- Class
- Event
- Mutual friend
- We haven't met *(styled differently — orange/warm — signals cold outreach, changes AI tone)*

Free text field below the chips for custom answers (e.g., "Stanford Engineering career fair last Tuesday"). Clicking a chip fills the text field; the student can edit or type their own.

**Question 2 — "What's your goal?"**

Quick-select chips:
- Set up a coffee chat
- Stay on their radar
- Ask about a role
- Get an introduction to someone
- Learn about their work
- Thank them

Free text field for custom goals.

**Question 3 — "Anything specific you want to mention?" (optional)**

Free text only. Placeholder: "e.g., We talked about their PM internship program"

**Actions:**
- "Skip — draft without context" — calls AI with whatever context is already on the contact (name, title, company, existing notes). Produces a more generic but still functional email. Follow-up plan still appears.
- "Generate draft" button

All answers are saved to the contact so the app never asks again for this person. If the user opens the intro flow again for the same contact (e.g., they closed without sending), the context form pre-fills with saved answers and can be edited.

### Phase 2: AI Drafts the Intro Email

After the student clicks "Generate draft":

1. Context questions collapse with a brief loading state ("Drafting your email...")
2. AI generates a subject line and email body using:
   - Contact name, title, company (from LinkedIn import)
   - How they know each other (from question 1)
   - The student's goal (from question 2)
   - Any specific notes (from question 3)
   - Existing contact notes/interaction history if available
   - Tone: professional but warm, appropriate for a student networking
3. Subject and body fields fill in, fully editable
4. Follow-up plan section appears below the body but follow-up content is NOT yet generated — just the structure (3 cards showing "7 days", "14 days", "21 days" with placeholder text like "Will be generated after you approve the intro")

The student can freely edit the intro email at this point.

### Phase 3: Approve Intro & Generate Follow-ups

When the student is happy with the intro email, they click an **"Approve & generate follow-ups"** button.

This triggers a second AI call that generates 3 follow-up emails based on:
- The **final approved intro email** (not the pre-edit version)
- The student's stated goal
- The contact context

Each follow-up is:
- A reply in the same thread (proper `In-Reply-To` / `References` headers)
- Progressively shorter and lighter in tone
- Related back to the original email's content and goal
- Scheduled 7 days apart at 9:05 AM local timezone

The follow-up cards update from placeholders to show truncated previews of the actual generated content.

**Error handling:** If the follow-up generation AI call fails, show an inline error with a "Retry" button. The student can still send the intro email without follow-ups — the Send button remains enabled. The follow-up section shows "Failed to generate — Retry or send without follow-ups."

### Phase 4: Review Follow-ups

Follow-up plan section shows 3 card rows:

- Each card shows: sequence number badge, projected send date ("Mon, Apr 1 · 9:05 AM"), truncated body preview
- Click a card to expand: shows full subject + body, all fields editable, timing adjustable
- ✕ button on each card to remove individual follow-ups
- Toggle to disable all follow-ups (re-enabling restores only remaining cards, not removed ones)
- "Auto-cancels if they reply" note at bottom

### Phase 5: Send

The send area offers:

- **"Send now"** — sends the intro immediately
- **"Tomorrow 9:05 AM"** — one-click preset to schedule for next morning
- **Custom time** — date/time picker (existing infrastructure)

Follow-up timing chains off the actual send time:
- If sent now → follow-up 1 is 7 days from now at 9:05 AM local TZ
- If scheduled for tomorrow 9:05 AM → follow-up 1 is 7 days after that at 9:05 AM

**Immediate send flow:**
1. Send intro via Gmail API → receive `messageId` and `threadId` in response
2. Create `email_follow_ups` record with `thread_id`, `original_gmail_message_id`, `contact_id`
3. Create `email_follow_up_messages` records with computed `scheduled_send_at` (UTC timestamps)

**Scheduled send flow:**
1. Create `scheduled_emails` record for the intro
2. Create `email_follow_ups` record with `scheduled_email_id` set, but `thread_id` and `original_gmail_message_id` left null
3. Create `email_follow_up_messages` records with `scheduled_send_at` relative to the scheduled intro time
4. When the scheduled email cron sends the intro, it populates `thread_id` and `original_gmail_message_id` on the `email_follow_ups` record, activating the follow-up sequence

### Post-Send Visibility

- **Contact detail page only** — a small status section showing "Follow-up sequence active: 1 of 3 sent, next Apr 8"
- **NOT in the home page action list** — the entire point is that follow-ups happen automatically without student action

## Technical Design

### API Endpoints

**POST /api/ai/draft-intro**

Generates the intro email only. Reuses the contact-fetching logic from the existing `/api/gmail/ai-write` endpoint (shared helper function for loading contact details, company, school, meetings, notes) to avoid code duplication.

Input:
```ts
{
  contactId: number;
  howMet?: string;
  goal?: string;
  notes?: string;
}
```

Returns: `{ subject: string, bodyHtml: string }`

Server-side: calls shared `getContactContext(contactId)` helper, then calls Claude API with an intro-specific prompt that incorporates the goal and how-met context.

**POST /api/ai/draft-follow-ups**

Generates 3 follow-up emails based on the approved intro. Uses the same shared contact-fetching helper.

Input:
```ts
{
  contactId: number;
  introSubject: string;
  introBodyHtml: string;
  goal?: string;
  howMet?: string;
}
```

Returns:
```ts
{
  followUps: Array<{
    subject: string;
    bodyHtml: string;
    delayDays: number;
  }>
}
```

AI-generated HTML is sanitized with `isomorphic-dompurify` (server-safe DOMPurify wrapper) before being returned to the client and before being stored in the database.

**POST /api/cron/send-follow-ups**

Processes due follow-up emails. Called by QStash every 15 minutes.

1. Query `email_follow_up_messages` joined through `email_follow_ups` to get `user_id`, filtering where `status = 'pending'` and `scheduled_send_at <= now` and parent `email_follow_ups.thread_id IS NOT NULL` (ensures scheduled intros have actually been sent)
2. For each user with pending messages, look up their `gmail_connections` record for OAuth tokens
3. If Gmail is disconnected or tokens are expired/revoked → skip this user's messages (leave as pending, they'll be retried next cycle; if `scheduled_send_at` is more than 3 days in the past, mark the parent `email_follow_ups` as `cancelled_user` and all pending messages as `cancelled` — the user has likely disconnected intentionally)
4. For each pending message, check Gmail for replies in the thread via `threads.get` (batch: one `threads.get` call per unique `thread_id`, not per message)
5. If reply found → set parent `email_follow_ups.status = 'cancelled_reply'`, cancel all pending messages in the sequence
6. If no reply → atomically update message status to `sending` in a transaction, send via Gmail as a reply (same `thread_id`, proper `In-Reply-To` / `References` headers), then update to `sent`. The atomic status check prevents duplicate sends on QStash retries.

Secured with QStash signature verification (`@upstash/qstash` Receiver).

### Database

**Migration: Intro email flow schema changes**

```sql
-- Add contact_id to email_follow_ups for contact detail page queries
ALTER TABLE email_follow_ups
  ADD COLUMN contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX idx_email_follow_ups_contact ON email_follow_ups (contact_id);

-- Allow null thread_id and message_id for scheduled sends (populated when intro actually sends)
ALTER TABLE email_follow_ups ALTER COLUMN original_gmail_message_id DROP NOT NULL;
ALTER TABLE email_follow_ups ALTER COLUMN thread_id DROP NOT NULL;

-- Add 'sending' status for atomic idempotent send (prevents duplicate sends on QStash retries)
ALTER TABLE email_follow_up_messages DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;
ALTER TABLE email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled'));

-- Add intro_goal to contacts
ALTER TABLE contacts ADD COLUMN intro_goal TEXT;
```

The existing `met_through` column on `contacts` will be reused for the "How do you know [Name]?" answer instead of adding a duplicate `how_met` column. The existing `/api/gmail/ai-write` endpoint already reads `met_through` for context.

The existing `scheduled_email_id` column on `email_follow_ups` (added in the scheduled_emails migration) links follow-up sequences to scheduled intros for activation after the intro sends.

**Existing tables used as-is:**
- `email_follow_ups` — tracks the sequence (thread_id, status, original send info, contact_id)
- `email_follow_up_messages` — individual follow-up emails (subject, body_html, scheduled_send_at, status)
- `scheduled_emails` — used if the intro itself is scheduled (not sent immediately)

**Timezone handling:** All `scheduled_send_at` values are stored as UTC timestamps, computed at creation time from the user's browser timezone. If the user changes timezones between creation and send, the original computed time is used. This is an accepted trade-off.

### New Components

1. **IntroContextForm** — The context questions section that replaces the blank body area. Renders chips + text fields. Manages local state, calls `onGenerate` with answers.

2. **FollowUpPlanSection** — The card rows below the email body. Receives follow-up data as props. Manages expand/collapse state. Calls parent callbacks for edit/remove/toggle.

### Modified Components

1. **ComposeEmailModal** — When `isIntro` is true:
   - Phase 1: Render IntroContextForm in the body area
   - Phase 2: After generate, show email body + FollowUpPlanSection (placeholders)
   - Phase 3: After approve, generate follow-ups and update FollowUpPlanSection
   - Phase 5: On send, create follow-up records in DB
   - Add "Tomorrow 9:05 AM" schedule preset button
   - Use a discriminated union type for the intro phase state (`'context' | 'generating' | 'editing' | 'generating-followups' | 'ready'`) to manage transitions cleanly and prevent impossible state combinations

2. **ComposeEmailContext** — Add `contactId` to ComposeOptions so the modal can fetch contact data and save context answers. Update existing `openCompose` call sites in `page.tsx` (lines ~602-608 and ~633-639) to pass `contactId` — the contact `id` is already available in the loaded data.

### Shared Helpers

Extract contact-fetching logic from `/api/gmail/ai-write/route.ts` into a shared helper:

```ts
// lib/ai-helpers.ts
export async function getContactContext(contactId: number): Promise<ContactContext> {
  // Fetches contact details, company, school, meetings, notes
  // Currently duplicated in ai-write — extract and share
}
```

Both `draft-intro` and `draft-follow-ups` endpoints use this helper.

### QStash Integration

- Create Upstash account, get QStash credentials
- Add `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` to Vercel env vars
- QStash calls `POST /api/cron/send-follow-ups` every 15 minutes
- API route verifies QStash signature before processing
- Install `@upstash/qstash` package for signature verification

### Context Saving

When the student answers questions:
- "How do you know them?" → saved to `contacts.met_through` column (existing column)
- "What's your goal?" → saved to `contacts.intro_goal` column (new)
- "Anything to mention?" → appended to contact notes via `appendContactNote`

These persist so:
- The app never asks these questions again for this contact (form pre-fills with saved values on re-entry)
- Future AI interactions have richer context
- The contact detail page can display "Met at: Stanford Career Fair"

## Implementation Order

### Phase 1: Context Gathering + AI Draft
1. Add `intro_goal` column to contacts + `contact_id` column to `email_follow_ups` (migration)
2. Extract shared `getContactContext` helper from `ai-write`
3. Add `contactId` to ComposeOptions / compose context; update `openCompose` call sites
4. Build IntroContextForm component
5. Build POST /api/ai/draft-intro endpoint (uses shared helper)
6. Wire into ComposeEmailModal: show context form when isIntro, generate draft on submit

### Phase 2: Follow-up Plan UI
7. Build FollowUpPlanSection component (card rows with expand/edit)
8. Build POST /api/ai/draft-follow-ups endpoint
9. Add "Approve & generate follow-ups" button to compose modal
10. Wire follow-up generation after intro approval (with error handling + retry)

### Phase 3: Send + Schedule
11. Add "Tomorrow 9:05 AM" schedule preset to send area
12. On immediate send: create email_follow_ups + email_follow_up_messages records after Gmail returns messageId/threadId
13. On scheduled send: create records with null thread_id; update when scheduled email actually sends
14. Compute all scheduled_send_at as UTC timestamps from browser timezone

### Phase 4: Follow-up Processing
15. Set up QStash account and env vars
16. Build POST /api/cron/send-follow-ups endpoint with idempotent send logic
17. Gmail thread reply detection (batched by thread_id)
18. Handle disconnected Gmail gracefully (skip + retry, cancel after 3 days)

### Phase 5: Post-Send Visibility
19. Add follow-up status section to contact detail page
20. Ability to cancel remaining follow-ups from contact page

## Out of Scope

- Editable/custom email templates
- Follow-up flows for non-intro emails
- Email open/click tracking
- A/B testing follow-up timing
- Follow-ups in the home page action list

# 22 — Smart Intro Email Flow: Implementation Plan

**Spec:** `docs/superpowers/specs/2026-03-25-intro-email-flow-design.md`

## Overview

Guided intro email flow inside the compose modal: context questions → AI draft → approve → AI follow-ups → send with auto-scheduled follow-up replies.

---

## Batch 1: Database + Plumbing

**Goal:** Schema changes and shared helpers — no UI yet.

### Task 1.1: Database migration

Create `supabase/migrations/20260325000000_intro_email_flow.sql`:

```sql
-- Add contact_id to email_follow_ups for contact detail page queries
ALTER TABLE email_follow_ups
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_follow_ups_contact ON email_follow_ups (contact_id);

-- Allow null thread_id and message_id for scheduled sends
ALTER TABLE email_follow_ups ALTER COLUMN original_gmail_message_id DROP NOT NULL;
ALTER TABLE email_follow_ups ALTER COLUMN thread_id DROP NOT NULL;

-- Add 'sending' status for idempotent cron sends
ALTER TABLE email_follow_up_messages DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;
ALTER TABLE email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled'));

-- Add intro_goal to contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intro_goal TEXT;
```

**Verification:** Migration file exists and is syntactically valid SQL. User will apply via `supabase db push`.

### Task 1.2: Extract shared `getContactContext` helper

Create `careervine/src/lib/ai-helpers.ts`.

Extract the contact-fetching logic from `/api/gmail/ai-write/route.ts` (lines 15-105) into a reusable function:

```ts
export interface ContactContext {
  contactName: string;
  senderName: string;
  contactInfo: string;   // formatted context string
  meetingNotes: string;   // formatted meeting context
}

export async function getContactContext(
  userId: string,
  contactId: number,
  meetingIds?: number[]
): Promise<ContactContext>
```

Then update `/api/gmail/ai-write/route.ts` to import and use this helper instead of its inline copy. This is a refactor — behavior should not change.

**Verification:** Run existing tests. The `ai-write` endpoint should still work identically.

### Task 1.3: Add `contactId` to compose context

Modify `careervine/src/components/compose-email-context.tsx`:

1. Add `contactId?: number` to `ComposeOptions` (line 18)
2. Add `contactId: number` to `ComposeContextValue` (line 31), default `0`
3. Add state: `const [contactId, setContactId] = useState(0)`
4. Set in `openCompose`: `setContactId(opts?.contactId || 0)`
5. Clear in `closeCompose`: `setContactId(0)`
6. Pass through context provider value

Then update call sites in `careervine/src/app/page.tsx`:

- `handleDraftEmail` (~line 602): add `contactId: contact.id` (contact id comes from `followUps.find`)
- `handleNewContactIntro` (~line 633): add `contactId: contact.id` (contact id comes from `newContacts.find`)

**Verification:** Build passes. Compose modal still opens normally. `contactId` is available via `useCompose()`.

---

## Batch 2: IntroContextForm Component

**Goal:** Replace the blank intro prompt with context questions inside the compose modal.

### Task 2.1: Build IntroContextForm component

Create `careervine/src/components/intro-context-form.tsx`.

**Props:**
```ts
interface IntroContextFormProps {
  contactName: string;
  contactId: number;
  initialMetThrough?: string;   // pre-fill from contact.met_through
  initialGoal?: string;          // pre-fill from contact.intro_goal
  onGenerate: (context: { howMet: string; goal: string; notes: string }) => void;
  onSkip: () => void;
  generating: boolean;
}
```

**UI (matches approved mockup — option A: chips + text field below):**

- Light green background section (`bg-primary/[0.03]`)
- "✨ Help us personalize this email" header in primary color
- **Q1: "How do you know [contactName]?"**
  - Chips: Career fair, LinkedIn, Class, Event, Mutual friend
  - "We haven't met" chip styled with orange/warm colors
  - Free text field below chips — clicking a chip fills it, user can edit
  - Pre-fills from `initialMetThrough` if provided
- **Q2: "What's your goal?"**
  - Chips: Set up a coffee chat, Stay on their radar, Ask about a role, Get an introduction, Learn about their work, Thank them
  - Free text field below
  - Pre-fills from `initialGoal` if provided
- **Q3: "Anything specific you want to mention?" (optional)**
  - Free text only
  - Placeholder: "e.g., We talked about their PM internship program"
- Footer: "Skip — draft without context" link (left), "Generate draft ✨" button (right)
- When `generating` is true, show loading state: "Drafting your email..." with progress bar animation

**Behavior:**
- Clicking a chip fills the corresponding text field (user can override)
- "Generate draft" calls `onGenerate` with the three values
- "Skip" calls `onSkip`

### Task 2.2: Wire IntroContextForm into ComposeEmailModal

Modify `careervine/src/components/compose-email-modal.tsx`:

1. Add intro phase state using discriminated union:
   ```ts
   type IntroPhase = 'context' | 'generating' | 'editing' | 'generating-followups' | 'ready';
   const [introPhase, setIntroPhase] = useState<IntroPhase>('context');
   ```

2. Replace the existing `introPromptVisible` / `introGenerating` booleans with the phase state machine.

3. In the body area, when `isIntro && introPhase === 'context'`:
   - Render `<IntroContextForm>` instead of the "Draft an introduction email" button
   - Need to fetch `met_through` and `intro_goal` from the contact to pre-fill: `GET /api/contacts/${contactId}` or use data already available

4. When `onGenerate` fires → set phase to `'generating'`, call `/api/ai/draft-intro`, on success set phase to `'editing'` and fill subject + body

5. When `onSkip` fires → set phase to `'generating'`, call `/api/ai/draft-intro` with empty context, same flow

6. Save context to contact on generate: `PATCH /api/contacts/${contactId}` to update `met_through` and `intro_goal`, plus `appendContactNote` for the free text notes

**Verification:** Click intro button → see context questions → fill in → click Generate → see loading → see email draft. Skip also works. Existing non-intro compose flow unchanged.

---

## Batch 3: AI Draft Intro Endpoint

**Goal:** Server-side AI endpoint that generates the intro email.

### Task 3.1: Build POST /api/ai/draft-intro

Create `careervine/src/app/api/ai/draft-intro/route.ts`.

**Schema:** `{ contactId: number, howMet?: string, goal?: string, notes?: string }`

**Handler:**
1. Call `getContactContext(user.id, contactId)` from shared helper
2. Build a Claude API prompt that includes:
   - Sender name + contact context (name, title, company, school, notes)
   - How they met (`howMet`)
   - The student's goal (`goal`)
   - Specific notes (`notes`)
   - Tone instruction: professional but warm, student networking, concise
   - If `howMet` contains "haven't met" → cold outreach tone
3. Call Claude API (same pattern as `ai-write`: `getOpenAIClient()` with `DEFAULT_MODEL`)
4. Parse response into `{ subject, bodyHtml }`
5. Sanitize HTML with `isomorphic-dompurify` (install package)
6. Return response

**Add schema** to `careervine/src/lib/api-schemas.ts`:
```ts
export const aiDraftIntroSchema = z.object({
  contactId: z.number(),
  howMet: z.string().optional(),
  goal: z.string().optional(),
  notes: z.string().optional(),
});
```

**Verification:** Call endpoint directly with test data → returns valid subject + HTML body. Test with and without context (skip path).

---

## Batch 4: Follow-up Plan UI

**Goal:** Card rows showing follow-up schedule below the email body, with expand-to-edit.

### Task 4.1: Build FollowUpPlanSection component

Create `careervine/src/components/follow-up-plan-section.tsx`.

**Props:**
```ts
interface FollowUpDraft {
  id: string;             // local key
  subject: string;
  bodyHtml: string;
  delayDays: number;
  projectedDate: string;  // formatted for display: "Mon, Apr 1 · 9:05 AM"
}

interface FollowUpPlanSectionProps {
  followUps: FollowUpDraft[];
  enabled: boolean;
  loading: boolean;          // true during "generating-followups" phase
  error: string | null;      // set if generation failed
  placeholder: boolean;      // true when showing placeholder cards before generation
  onToggle: (enabled: boolean) => void;
  onEdit: (id: string, updates: Partial<FollowUpDraft>) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;       // retry follow-up generation
}
```

**UI (approved mockup — option B: always show preview, click to expand):**

- Header row: "Follow-up plan" label + "AI-generated" badge + toggle switch
- When `placeholder` is true: 3 cards with placeholder text "Will be generated after you approve the intro" and grayed out
- When loaded: 3 card rows, each showing:
  - Numbered badge (1, 2, 3) in green circle
  - Projected send date ("Mon, Apr 1 · 9:05 AM")
  - Truncated body preview (2-3 lines, `line-clamp-3`)
  - ✕ remove button
- Click a card → expands to show:
  - Subject field (editable input)
  - Body (editable textarea or RichTextEditor)
  - Timing dropdown: 7/14/21/30 days
  - Click outside or click header → collapses, saves changes
- When `error` is set: show "Failed to generate — Retry or send without follow-ups" with Retry button
- Footer note: "Auto-cancels if they reply"
- When `enabled` is false: cards visually dimmed

### Task 4.2: Add "Approve & generate follow-ups" button to compose modal

In `ComposeEmailModal`, when `introPhase === 'editing'`:

1. Show the FollowUpPlanSection below the email body with `placeholder: true`
2. Show an "Approve & generate follow-ups" button (primary style, positioned between body and follow-up section)
3. On click → set `introPhase` to `'generating-followups'`, call `/api/ai/draft-follow-ups`
4. On success → set `introPhase` to `'ready'`, populate follow-up cards with AI content
5. On error → show error in FollowUpPlanSection, keep introPhase as `'editing'` so user can retry or skip

**Verification:** Full flow works: context → generate intro → edit → approve → follow-ups appear with previews → can expand/edit/remove.

---

## Batch 5: AI Draft Follow-ups Endpoint

**Goal:** Server-side endpoint that generates 3 follow-up emails.

### Task 5.1: Build POST /api/ai/draft-follow-ups

Create `careervine/src/app/api/ai/draft-follow-ups/route.ts`.

**Schema:**
```ts
export const aiDraftFollowUpsSchema = z.object({
  contactId: z.number(),
  introSubject: z.string(),
  introBodyHtml: z.string(),
  goal: z.string().optional(),
  howMet: z.string().optional(),
});
```

**Handler:**
1. Call `getContactContext(user.id, contactId)` for contact info
2. Build Claude API prompt:
   - Include the full approved intro email (subject + body)
   - The student's goal
   - Instructions: generate 3 follow-up reply emails, each progressively shorter
   - Follow-up 1 (7 days): friendly check-in, reference original email
   - Follow-up 2 (14 days): add value or new angle related to goal
   - Follow-up 3 (21 days): final gentle bump, brief, acknowledges they're busy
   - All should be replies (Re: subject)
   - Tone matches original email
3. Parse response into array of `{ subject, bodyHtml, delayDays }`
4. Sanitize each with `isomorphic-dompurify`
5. Return `{ followUps: [...] }`

**Verification:** Call with a test intro email → returns 3 distinct follow-ups with appropriate tone progression.

---

## Batch 6: Send + Schedule with Follow-ups

**Goal:** When the user sends, create follow-up records in the database.

### Task 6.1: Add "Tomorrow 9:05 AM" schedule preset

In `ComposeEmailModal` footer, when `isIntro`:

- Add a "Tomorrow 9:05 AM" button next to Send/Schedule
- On click: compute tomorrow at 9:05 AM in local timezone, convert to UTC ISO string, call `handleScheduleSend` with that datetime
- Style: outline button with Clock icon, similar to existing Schedule button

### Task 6.2: Create follow-up records on immediate send

After `handleSendNow` succeeds (line ~239, after `setSent(true)`):

1. Check if follow-ups are enabled and there are follow-up drafts
2. Get `messageId` and `threadId` from the Gmail send response (need to update `/api/gmail/send` to return these — check if it already does)
3. Call a new function `createFollowUpSequence(userId, { contactId, threadId, messageId, recipientEmail, contactName, originalSubject, originalSentAt, followUps })` that:
   - Creates an `email_follow_ups` row
   - Creates `email_follow_up_messages` rows with `scheduled_send_at` = sendTime + delayDays at 9:05 AM local TZ (passed as UTC)
4. Error creating follow-ups should not block the send success flow — catch and log

### Task 6.3: Create follow-up records on scheduled send

After `handleScheduleSend` succeeds (line ~297, after `setScheduled(true)`):

1. Same as above but:
   - Get `scheduledEmailId` from the schedule response
   - Create `email_follow_ups` with `scheduled_email_id` set, `thread_id` and `original_gmail_message_id` null
   - Compute `scheduled_send_at` relative to the scheduled send time (not now)

### Task 6.4: Activate follow-ups when scheduled email sends

Modify the scheduled email sending cron (if one exists) or the existing `scheduled_emails` processing logic:

- After successfully sending a scheduled email, check if there's an `email_follow_ups` row with matching `scheduled_email_id`
- If found, update it with the `thread_id` and `original_gmail_message_id` from the Gmail response
- This activates the follow-up sequence

**Verification:** Send an intro email → check database → `email_follow_ups` and `email_follow_up_messages` rows exist with correct timestamps. Schedule flow: records created with null thread_id.

---

## Batch 7: QStash + Follow-up Processing Cron

**Goal:** Background job that sends due follow-ups and detects replies.

### Task 7.1: Install QStash and set up verification

1. `npm install @upstash/qstash` in `careervine/`
2. Add env vars to `.env.local` and Vercel: `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
3. Create QStash schedule pointing to `POST /api/cron/send-follow-ups` every 15 minutes (user does this in Upstash dashboard)

### Task 7.2: Build POST /api/cron/send-follow-ups

Create `careervine/src/app/api/cron/send-follow-ups/route.ts`.

**No auth schema** — secured by QStash signature verification instead.

**Handler:**
1. Verify QStash signature using `Receiver` from `@upstash/qstash`
2. Query pending messages:
   ```sql
   SELECT m.*, f.user_id, f.thread_id, f.recipient_email, f.contact_name, f.original_subject
   FROM email_follow_up_messages m
   JOIN email_follow_ups f ON f.id = m.follow_up_id
   WHERE m.status = 'pending'
     AND m.scheduled_send_at <= now()
     AND f.thread_id IS NOT NULL
     AND f.status = 'active'
   ORDER BY m.scheduled_send_at ASC
   LIMIT 20
   ```
3. Group by `user_id` → for each user:
   a. Look up `gmail_connections` for OAuth tokens
   b. If disconnected → check if `scheduled_send_at` is 3+ days ago → cancel sequence, else skip
   c. Batch reply detection: one `threads.get` per unique `thread_id`
   d. If reply found → update parent to `cancelled_reply`, cancel all pending messages
   e. If no reply → atomically set status to `sending`, send via Gmail as reply, set to `sent`
4. Return `{ processed: N, sent: N, cancelled: N }`

**Gmail reply detection:** Call `threads.get(threadId)` with `format: 'metadata'`. If the thread has more messages than the original, a reply exists. Check that at least one message is NOT from the user's own address.

**Sending as reply:** Use the existing Gmail send infrastructure with `threadId`, `inReplyTo` (original message ID), and `references` headers set.

**Verification:** Create test follow-up records with past `scheduled_send_at`. Call the endpoint → messages are processed. Test with a replied thread → messages are cancelled.

---

## Batch 8: Post-Send Visibility

**Goal:** Show follow-up status on the contact detail page.

### Task 8.1: Add follow-up status to contact detail page

In `careervine/src/app/contacts/[id]/page.tsx`:

1. Query `email_follow_ups` for this contact (via `contact_id`)
2. If active sequence exists, show a small card:
   - "Follow-up sequence active"
   - "2 of 3 sent · Next: Mon, Apr 8"
   - "Cancel remaining" button
3. If completed or cancelled, show brief history: "3 follow-ups sent" or "Cancelled — they replied"

### Task 8.2: Cancel follow-ups from contact page

Add a "Cancel remaining follow-ups" action:
1. Set parent `email_follow_ups.status = 'cancelled_user'`
2. Set all pending `email_follow_up_messages.status = 'cancelled'`
3. Update UI immediately

**Verification:** Send an intro with follow-ups → go to contact page → see status → cancel → status updates.

---

## Batch Summary

| Batch | Tasks | Description |
|-------|-------|-------------|
| 1 | 1.1–1.3 | Database migration, shared helper, compose context plumbing |
| 2 | 2.1–2.2 | IntroContextForm component + wire into compose modal |
| 3 | 3.1 | AI draft-intro endpoint |
| 4 | 4.1–4.2 | FollowUpPlanSection component + approve button |
| 5 | 5.1 | AI draft-follow-ups endpoint |
| 6 | 6.1–6.4 | Send/schedule with follow-up record creation |
| 7 | 7.1–7.2 | QStash setup + follow-up processing cron |
| 8 | 8.1–8.2 | Contact detail page follow-up status + cancel |

## Dependencies

- Batch 2 depends on Batch 1 (compose context needs contactId)
- Batch 3 depends on Batch 1 (shared helper)
- Batch 4 depends on Batch 2 (needs compose modal phase state)
- Batch 5 depends on Batch 1 (shared helper)
- Batch 6 depends on Batches 4 + 5 (needs follow-up UI + generation)
- Batch 7 depends on Batch 6 (needs follow-up records to exist)
- Batch 8 depends on Batch 6 (needs follow-up records to exist)

Batches 3 and 5 (API endpoints) can be built in parallel with their UI counterparts if desired.

## Review Checkpoints

- **After Batch 2:** User can test the full context → AI draft flow end-to-end
- **After Batch 5:** User can test the complete modal flow: context → draft → approve → follow-ups
- **After Batch 6:** User can send a real intro email with follow-ups scheduled
- **After Batch 8:** Feature is complete

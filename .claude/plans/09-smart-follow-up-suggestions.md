# Smart Follow-Up Suggestions

## Problem

The dashboard currently tells users **who** is overdue but not **why** they should reach out or **what** to say. The "Reach Out Today" section shows generic messages like "Follow-up 45d overdue" — useful but not actionable. Meanwhile, the AI draft system generates email content but only for cadence-overdue contacts, and doesn't surface the reasoning in a scannable way.

Users glance at "Reach Out Today," see a list of names + days overdue, and feel guilt instead of motivation. The feature should turn that guilt into a specific, compelling reason to act.

Separately, the **Action Items page is underserving users**. It's purely manual — every item is user-created, descriptions are static, and there's no intelligence helping users figure out what to prioritize. It's a flat task list when it could be the single hub for "everything I need to do for my network."

## Vision

On each login, the app scans the user's network and generates **3-5 focused, actionable suggestions** — not a comprehensive list, but a short answer to "what should I do right now?" Suggestions are **ephemeral by default**: fresh each session, never piling up.

**The key unification:** When a user sees a suggestion they want to act on later, **saving it creates an action item** — pre-filled with the AI-generated headline, context, and linked contact. This makes the action items page the **single source of truth** for "things I need to do," whether manually created or AI-suggested. No separate saved suggestions system, no second inbox.

Example suggestions:
- "Sarah mentioned she was starting a new role at Stripe — check in on how it's going"
- "You talked to Marcus about his startup fundraise in January — follow up on how it went"
- "Jamie's graduation is coming up in May — congratulate them and ask about their job search"
- "You added Alex 2 months ago but haven't logged a conversation yet — their cadence is due in 3 days"

## What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| Cadence tracking + overdue detection | Built | `queries.ts:getContactsDueForFollowUp()` |
| Health color system (green/yellow/orange/red) | Built | `health-helpers.ts` |
| Contact context gathering (meetings, transcripts, interactions, profile) | Built | `ai-followup/gather-context.ts` |
| Interest extraction from conversations | Built | `ai-followup/extract-interests.ts` |
| Article search (Serper API) | Built | `ai-followup/find-article.ts` |
| AI email draft generation | Built | `ai-followup/generate-draft.ts` |
| AI draft storage + UI cards | Built | `ai_follow_up_drafts` table, dashboard inline cards |
| Dashboard "Reach Out Today" section | Built | `page.tsx` lines 577-684 |
| Action items page | Built | `app/action-items/page.tsx` — CRUD, four-section grouping (Overdue / Due this week / Due later / No due date) |
| Action item priority system | Built | `priority-helpers.ts` — high (red) / medium (amber) / low (blue), click-to-cycle dots, `sortByPriorityThenDate` |
| Action items on dashboard | Built | `page.tsx` "Pending follow-ups" section, top 10 |
| Action items on contact profile | Built | `contact-actions-tab.tsx` (priority-aware sorting), `contact-pending-actions-banner.tsx` |
| Action items from meetings | Built | Created during meeting logging, linked via `meeting_id` |
| Contact expected_graduation field | Built | `contacts.expected_graduation` |
| Contact status (student/professional) | Built | `contacts.contact_status` |

**Key gaps:**
1. The interest extraction pipeline runs at draft-generation time — no standalone "suggestion" layer surfaces contextual reasons *before* the user decides to act.
2. Action items are 100% manual — the system never proactively suggests what to do.
3. There's no way to distinguish AI-suggested action items from manual ones visually or in queries.

## Core Design Principles

### Ephemeral by Default, Save to Action Items

Suggestions are **not persisted** unless the user explicitly saves one. Saving a suggestion **creates an action item** in the existing `follow_up_action_items` table with AI-generated content pre-filled. This prevents overwhelm while giving users one place to manage all their to-dos.

**Lifecycle:**
```
User logs in
     ↓
Generate 3-5 suggestions (rule-based + 1 LLM call)
     ↓
Display in a lightweight section on dashboard + action items page
     ↓
User can:
  • Act now → opens compose / generate draft flow
  • Save → creates an action item (pre-filled title, description, contact)
  • Ignore → gone next session, might regenerate if still relevant
```

**Why unify with action items?** If saved suggestions live in their own table, users now have two places to check — "action items" and "saved suggestions." That's fragmented UX. By flowing suggestions into action items, the action items page becomes the single hub for everything the user needs to do, whether they thought of it or the AI did.

### Suggestions Are Secondary, Not Center Stage

Suggestions live in a compact section on the dashboard — **below** "Reach Out Today" and action items, which remain the primary call to action. Think of suggestions as a helpful nudge, not a task list. The section header is something like "Ideas for today" or "Suggested outreach."

### Zero-Interaction Contacts Are Fair Game

Contacts with no logged interactions but an approaching cadence deadline are great suggestion candidates:
- "You added Alex 2 months ago but haven't had a conversation yet — their follow-up cadence is due in 3 days"
- "You imported Jamie from LinkedIn last month — introduce yourself before they forget where you met"

## Architecture

### Suggestion Flow

```
User loads dashboard (or action items page)
        ↓
   Generate suggestions (in-memory, not persisted)
   ├─ Rule-based pass (fast, no LLM)
   │  • Graduation approaching
   │  • Zero-interaction contacts with cadence due
   │  • Cadence decay warnings
   └─ LLM pass (1 batched call for remaining slots)
      • Contextual reasons from conversation history
      • Forward-looking event follow-through
        ↓
   Filter out contacts that already have a pending
   AI-suggested action item (deduplication)
        ↓
   Return 3-5 top suggestions to client
        ↓
   User sees suggestions
   ├─ [Act now] → opens compose or generate-draft flow
   ├─ [Save] → creates action item (source='ai_suggestion')
   └─ [Ignore] → disappears next session
```

### Suggestion Sources (Ranked by Priority)

#### 1. Life Event Triggers (rule-based, no LLM needed)
Extract from structured data already in the database:
- **Expected graduation** — `contacts.expected_graduation` approaching (within 30 days) or recently passed
- **New role** — `contact_companies.is_current` changed recently (detected from interaction notes or LinkedIn re-import)
- **Zero interactions + cadence due** — Contact was added but never contacted, and their follow-up cadence is approaching or overdue

#### 2. Conversation Topic Follow-Through (LLM-powered)
Mine past meeting notes, transcripts, and interaction summaries for **forward-looking statements** — things the contact said they were *about to do*:
- "I'm interviewing at Google next month"
- "We're launching the product in Q2"
- "I'm thinking about going back to school"
- "Moving to New York in the spring"

These have a natural follow-up window. The LLM extracts the event + estimated timeframe, and a suggestion fires when that window arrives.

#### 3. Cadence-Overdue with Context (LLM-powered, replaces current generic reasons)
For contacts that are simply overdue, provide a contextual reason drawn from the last interaction:
- "Last time you talked, Marcus was excited about his new team — check in"
- "You discussed Sarah's research project in January — see how it's progressing"

#### 4. Relationship Decay Warning (rule-based)
Contacts whose health color is about to drop from green → yellow or yellow → orange:
- "You usually check in with Jamie every 2 weeks — due in 3 days"
- Proactive nudge *before* they become overdue

### Data Model

#### Changes to `follow_up_action_items` table

```sql
alter table follow_up_action_items
  add column source text not null default 'manual',        -- 'manual' | 'ai_suggestion'
  add column suggestion_reason_type text,                   -- 'life_event' | 'topic_followthrough' | 'cadence_context' | 'decay_warning' | 'zero_interaction'
  add column suggestion_headline text,                      -- The contextual "why" — displayed prominently on AI items
  add column suggestion_evidence text;                      -- Quote or data point backing the suggestion
```

**Note:** The table already has a `priority` column (`'high' | 'medium' | 'low' | null`) added in migration `20260321300000`. AI-suggested action items are saved with `priority = null` by default — the user can set priority themselves after saving, using the same click-to-cycle dot that works on all action items.

**Why extend the existing table instead of a new one?**
- Saved suggestions ARE action items — same lifecycle (pending → done/dismissed), same display locations (dashboard, action items page, contact profile)
- No need for a junction table or foreign keys between two systems
- Existing queries (`getActionItems`, `getActionItemsForContact`, etc.) automatically pick up AI items
- AI items inherit all existing behaviors: priority dots, four-section date grouping, `sortByPriorityThenDate`, contact linking
- The `source` column lets us visually distinguish and filter them

#### New user preference columns

```sql
-- Email digest preferences (added to user_profiles or a new user_settings table)
alter table user_profiles
  add column suggestion_digest_enabled boolean not null default false,
  add column suggestion_digest_frequency text not null default 'weekly',  -- 'daily' | 'weekly'
  add column suggestion_digest_count integer not null default 3;          -- how many suggestions per digest (1-10)
```

### API Routes

#### `POST /api/suggestions/generate`
Triggered on dashboard load and action items page load. Returns 3-5 ephemeral suggestions (not persisted).

**Logic:**
1. Fetch contacts with their last touch, cadence, recent interactions
2. Fetch existing AI-suggested action items (`source = 'ai_suggestion'`, `is_completed = false`) to avoid duplicates
3. **Rule-based pass** (fast, no LLM):
   - Check `expected_graduation` against current date
   - Find zero-interaction contacts with cadence approaching/overdue
   - Check for contacts approaching cadence threshold (decay warning)
4. **LLM pass** (batched, single call) — only if rule-based pass didn't fill all 5 slots:
   - For top N overdue/due contacts that don't already have a pending AI action item
   - Batch their recent meeting notes/interaction summaries into one prompt
   - LLM returns structured JSON per contact
5. Merge, score, and return top 3-5 suggestions
6. **Nothing is persisted** — response is purely in-memory

#### `POST /api/suggestions/save`
Saves an ephemeral suggestion by creating an action item. Body: `{ contactId, headline, detail?, suggestedAction?, reasonType, sourceEvidence? }`

Creates a `follow_up_action_items` row:
- `title` ← headline (e.g., "Check in with Sarah about her new role at Stripe")
- `description` ← detail + suggested action
- `contact_id` ← contactId
- `source` ← `'ai_suggestion'`
- `suggestion_reason_type` ← reasonType
- `suggestion_headline` ← headline
- `suggestion_evidence` ← sourceEvidence
- `priority` ← null (user sets manually via click-to-cycle dot after saving)
- `due_at` ← null (user can set later)
- Also inserts into `action_item_contacts` junction table

Returns the created action item so the UI can update immediately.

#### `POST /api/suggestions/generate-draft`
Takes a suggestion context and generates an AI email draft (reuses existing `ai-followup/` pipeline). Body: `{ contactId, headline, suggestedAction?, evidence? }`

### LLM Prompt Design

#### Batch Suggestion Prompt (single call for multiple contacts)

```
System: You analyze a user's professional network contacts and their interaction
history to suggest who they should reach out to and why.

For each contact provided, determine the single best reason to reach out RIGHT NOW:
1. Is there a forward-looking topic from past conversations whose follow-up
   window has arrived? (e.g., they mentioned starting a new job, launching
   a product, interviewing somewhere)
2. If not, what was the most interesting or personal topic from the last
   conversation that could anchor a natural follow-up?
3. If there's no conversation history, say so — don't fabricate a reason.

Rules:
- Be SPECIFIC — reference actual topics, dates, and details from the conversations
- Suggest a concrete action ("ask how the launch went") not a vague reminder ("follow up")
- If there's genuinely nothing to go on, return null for that contact
- Headlines: under 80 characters, conversational tone
- Suggested actions: under 100 characters, starts with a verb

User: [formatted batch of contact contexts]
```

**Response schema (structured output):**
```json
{
  "suggestions": [
    {
      "contactId": 42,
      "headline": "Sarah mentioned starting at Stripe in February",
      "detail": "During your coffee chat on Jan 15, she said she was excited about joining the payments team.",
      "suggestedAction": "Ask how her first month at Stripe is going",
      "evidence": "she said she was excited about joining the payments team",
      "confidence": 0.9
    },
    {
      "contactId": 17,
      "headline": null,
      "detail": null,
      "suggestedAction": null,
      "evidence": null,
      "confidence": 0
    }
  ]
}
```

### Dashboard UX Changes

#### Suggestion Section Placement

```
Dashboard
├── Greeting + "Log conversation" button
├── Pending follow-ups (action items)      ← existing, stays primary
├── Reach Out Today (overdue contacts)     ← existing, stays primary
├── Suggested outreach (3-5 items)         ← NEW, secondary/compact
├── Network Health grid                    ← existing
└── Quick-add contact                      ← existing
```

#### Suggestion Card Design (Dashboard)

```
┌──────────────────────────────────────────────────────┐
│  [Avatar]  Sarah mentioned starting at Stripe        │
│            Ask how her first month is going           │
│            ·  45d since last contact                  │
│                                                      │
│            [Send a message]  [Save]  [Draft ✨]      │
└──────────────────────────────────────────────────────┘
```

**Design details:**
- **Headline** is the primary text — the contextual "why"
- **Suggested action** is secondary text — the "what to do"
- **Days since contact** shown as a subtle inline detail, not the primary info
- **"Save"** button (bookmark icon) creates an action item and shows a success toast with link to action items
- **"Draft"** button triggers on-demand AI draft generation
- **"Send a message"** opens compose with contact pre-filled
- Section collapses gracefully if no suggestions were generated (e.g., all contacts are healthy)

### Action Items Page Changes

The action items page gets two upgrades:

#### 1. "Suggested for you" banner at top

When the user visits the action items page, the same ephemeral suggestion engine runs. A collapsible banner at the top shows 3-5 suggestions the user can save (which instantly adds them to the list below).

```
┌─────────────────────────────────────────────────────────────┐
│  ✨ Suggested for you                            [Collapse] │
│                                                             │
│  [Avatar] Sarah mentioned starting at Stripe               │
│           Ask how her first month is going · 45d            │
│           [Save as action item]  [Draft ✨]                 │
│                                                             │
│  [Avatar] Jamie's graduation is in 6 weeks                 │
│           Congratulate them and ask about job search         │
│           [Save as action item]  [Draft ✨]                 │
│  ───────────────────────────────────────────────────────    │
│  These suggestions refresh each visit. Save the ones you    │
│  want to keep.                                              │
└─────────────────────────────────────────────────────────────┘
```

After saving, the suggestion card animates out of the banner and the new action item appears in the list below. The banner has a small footer note: "These suggestions refresh each visit. Save the ones you want to keep."

#### 2. AI-suggested action items get visual distinction

Action items with `source = 'ai_suggestion'` display differently from manual items but live in the same four-section layout (Overdue / Due this week / Due later / No due date). Since AI items are saved with `priority = null` and `due_at = null`, they'll initially land in the "No due date" section — users can then set priority (click-to-cycle dot) and due date (edit modal) to move them into the appropriate section.

```
┌──────────────────────────────────────────────────────────────┐
│  [✨] [●] Check in with Sarah about her new role at Stripe   │
│           Sarah Chen · AI suggestion                         │
│           "She mentioned joining the payments team"          │
│           No due date                                        │
│                                                [Edit] [Done] │
└──────────────────────────────────────────────────────────────┘
```

- Small sparkle icon (✨) before the priority dot distinguishes AI items from manual ones
- "AI suggestion" label in the metadata line (alongside contact name, meeting link, etc.)
- `suggestion_evidence` shown as a subtle quoted line below the title — the contextual "why"
- Same priority cycling behavior: click the dot to set high/medium/low, which reorders within the section via `sortByPriorityThenDate`
- Otherwise identical to manual items: edit, mark done, delete
- Users can edit the title/description after saving — it's their action item now

#### 3. Deduplication

When generating ephemeral suggestions, filter out contacts that already have a pending AI-suggested action item (`source = 'ai_suggestion'` AND `is_completed = false`). This prevents the banner from re-suggesting something the user already saved.

### Priority Scoring

Suggestions are ranked by a composite score to pick the best 3-5:

```typescript
function computePriority(suggestion: SuggestionCandidate): number {
  let score = 0.5; // base

  // Boost for life events (graduation, new role)
  if (suggestion.reasonType === 'life_event') score += 0.2;

  // Boost for zero-interaction contacts with cadence due
  if (suggestion.reasonType === 'zero_interaction') score += 0.15;

  // Boost for time-sensitive topic follow-through
  if (suggestion.reasonType === 'topic_followthrough') score += 0.15;

  // Boost for overdue contacts
  if (suggestion.daysOverdue && suggestion.daysOverdue > 0) {
    score += Math.min(0.2, suggestion.daysOverdue / 100);
  }

  // Boost for high-confidence LLM suggestions
  if (suggestion.confidence) {
    score += (suggestion.confidence - 0.5) * 0.2;
  }

  return Math.min(1.0, score);
}
```

### Cost Control

- **Per login:** 1 batched LLM call for 5-8 contacts (~$0.001-0.003 with gpt-4o-mini)
- **Rule-based suggestions** are free (DB queries only)
- **Draft generation** remains on-demand — no change to existing cost model
- **No new tables** — suggestions that are saved flow into existing `follow_up_action_items`
- **Deduplication:** Contacts with pending AI action items are skipped during generation

### Email Digest Feature

#### Settings Page Addition

New section in Settings under a "Notifications" or "Digest" group:

```
Smart Follow-Up Digest
──────────────────────
[ ] Send me a regular email with follow-up suggestions

Frequency:  [Weekly ▼]     (Daily | Weekly)
Suggestions per email:  [3 ▼]   (1-10)
```

#### Digest Implementation

- **Cron job** (Vercel cron or Supabase pg_cron) runs daily at ~8am user local time (or a fixed UTC time initially)
- For users with `suggestion_digest_enabled = true`:
  1. Run the same suggestion generation logic (rule-based + LLM batch)
  2. Pick top N suggestions (where N = `suggestion_digest_count`)
  3. Render into a simple HTML email template
  4. Send via Gmail API (if connected) or a transactional email service (e.g., Resend)
- **Weekly digest:** Runs on Monday mornings
- **Daily digest:** Runs every morning
- Email includes "Open in CareerVine" links for each suggestion

## Implementation Phases

### Phase 1: Suggestion Engine + Dashboard UI
**Scope:** Core generation logic, API route, dashboard integration. No persistence yet.

1. Create `POST /api/suggestions/generate` route
2. Implement rule-based suggestion generators:
   - Graduation approaching/passed
   - Zero-interaction contacts with cadence due/approaching
   - Cadence decay warning (approaching threshold)
3. Implement batch LLM suggestion generator (`src/lib/ai-followup/generate-suggestions.ts`)
4. Add suggestion types to `types.ts` (ephemeral `Suggestion` type, not a DB type)
5. Build "Suggested outreach" dashboard section (compact cards, 3-5 suggestions)
6. Wire dashboard to call generate on load and display results
7. Tests for rule-based generators and API route

### Phase 2: Save to Action Items + Action Items Page Enhancement
**Scope:** The unification — saving suggestions creates action items, action items page gets smarter.

1. Migration: add `source`, `suggestion_reason_type`, `suggestion_headline`, `suggestion_evidence` columns to `follow_up_action_items`
2. Update TypeScript types in `database.types.ts` and `types.ts`
3. Create `POST /api/suggestions/save` route (creates action item with `source='ai_suggestion'`)
4. Add "Save" button to dashboard suggestion cards → calls save endpoint → shows success toast
5. Update deduplication in generate route: filter contacts with pending AI action items
6. Build "Suggested for you" banner on action items page (same suggestion engine, collapsible)
7. Add visual distinction for AI-suggested action items (sparkle icon, evidence quote, "AI suggestion" label)
8. Update `getActionItems` query to include new columns in response
9. Tests for save flow, deduplication, action item display

### Phase 3: Draft Linkage
**Scope:** Connect suggestions to the existing AI draft pipeline.

1. Create `POST /api/suggestions/generate-draft` — wraps existing `ai-followup/` pipeline with suggestion context
2. Wire "Draft" button on suggestion cards (both dashboard and action items page) to generate-draft endpoint
3. When a draft is sent for an AI-suggested action item, auto-mark the action item as completed
4. Tests for draft generation from suggestion context

### Phase 4: Email Digest
**Scope:** Settings UI, cron job, email rendering + sending.

1. Add digest preference columns to user settings (or `user_profiles` table)
2. Build Settings page UI for digest toggle, frequency, and count
3. Create email template for suggestion digest
4. Implement cron endpoint (`/api/cron/suggestion-digest`) with auth guard
5. Wire cron to run on schedule (Vercel cron config)
6. Tests for digest generation and preference handling

### Phase 5: Polish & Iteration
**Scope:** UX refinement based on real usage.

1. Tune LLM prompts based on quality of generated suggestions
2. Adjust priority scoring weights
3. Loading skeleton for suggestion section while LLM call runs
4. Graceful handling when LLM returns no useful suggestions
5. Smooth animation when saving a suggestion (card slides from banner into action items list)
6. Consider: suggestion quality feedback (thumbs up/down) for prompt tuning

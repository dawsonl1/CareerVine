# Action Item Ownership & "Waiting On" System

## Vision

After every conversation, you walk away with promises — yours and theirs. CareerVine should track both, remind you to follow through on yours, and gently nudge you when someone hasn't delivered on theirs. No professional relationship tool does this well.

---

## User Stories

### Story 1: Coffee chat produces three types of follow-ups

**Dawson has a coffee chat with Alex, a Product Manager. He uploads the transcript.**

He clicks "Suggest action items from transcript." The AI returns:

```
YOUR COMMITMENTS
  ☐ Send Alex your CareerVine project for review          Due: Mar 20
    "Feel free to send me anything you're working on"
  ☐ Write 1-2 Medium articles about product decisions      No due date
    "I'd prioritize: document your decision-making process"

WAITING ON ALEX
  ⏳ Alex will review your project and give feedback        No timeline
    "Feel free to send me anything you're working on, I'm happy to give feedback"
  ⏳ Alex will send you an example product case study        No timeline
    "Send DP an example of a strong product case study"

MUTUAL
  🤝 Schedule follow-up check-in with Alex                  In 4-6 weeks
    "Schedule a follow-up check-in in ~4–6 weeks"
```

Dawson reviews the AI's work. He notices:
- "Ship at least one polished project" is too vague — he edits the title to "Polish CareerVine to demo-ready state"
- The "Send Alex your project" item has no due date — he clicks the date field and picks March 20 (48 hours from the chat)
- The AI classified "Write Medium articles" as `my_task` which is correct, but missed that it should be `mutual` since Alex said he'd read them — Dawson changes the direction dropdown to keep it as `my_task` since it's really his responsibility

He clicks "Add" on each one. They're saved with their direction and his edits.

**Value:** The AI does the heavy lifting of extraction and classification, but Dawson has full control to fix titles, add due dates, and correct categories before anything is saved. He captured 5 follow-ups from one conversation — without this, he'd remember 1-2 of his own tasks and completely forget that Alex offered to review his project and send a case study.

---

### Story 2: "Waiting on" item triggers a gentle follow-up

**10 days pass. Alex hasn't sent the case study or the project review feedback.**

Dawson opens the home page. In the "Suggested outreach" section, he sees:

```
✨ Alex offered to review your project 10 days ago
   Send a friendly check-in — they may have forgotten
   [✓ Did it] [↓ Save] [✕]
```

He clicks on Alex's profile and sees under action items:

```
WAITING ON ALEX
  ⏳ Alex will review your project — 10 days waiting
  ⏳ Alex will send example case study — 10 days waiting
```

He clicks "Did it" on the suggestion, which opens the Compose Email modal pre-filled with Alex's email. The AI drafts a polite check-in:

> **Subject:** Quick follow-up from our coffee chat
>
> Hey Alex, hope you've been well! Just wanted to follow up on our conversation from a couple weeks ago. I've been making progress on CareerVine and would love your feedback when you get a chance. No rush at all — I know things get busy!

**Value:** Dawson follows up at exactly the right time, with a message that's polite (not nagging) and references the actual conversation. Without this, he'd either forget entirely or send a generic "just checking in" message.

---

### Story 3: Dawson completes his own commitment and the linked "waiting on" updates

**Dawson sends Alex his project link. He marks "Send Alex your CareerVine project for review" as done.**

The linked "waiting on" item "Alex will review your project" now shows additional context: "You sent your project on Mar 20. Waiting for feedback." This context appears because the two items are linked — when you complete your side, the other side gets annotated with when you delivered.

**Value:** The relationship between your commitment and their commitment is tracked. You did your part; now you're waiting on theirs. When the nudge suggestion fires 7 days later, it can say "You sent your project 9 days ago — check in with Alex?"

---

### Story 4: Mutual commitment creates a future follow-up

**Dawson accepts the mutual item "Schedule follow-up check-in with Alex in 4-6 weeks."**

The app creates an action item due in 5 weeks (mid-range of 4-6 weeks). When that date approaches, it shows up in "Due this week" and in the reach-out-today section on the dashboard.

**Value:** The 4-6 week check-in doesn't fall through the cracks.

---

### Story 5: Action items page shows ownership clearly

**Dawson opens the action items page. He sees his items organized by ownership:**

```
OVERDUE (2)
  ⚠ Write Medium articles about product decisions           Overdue · 5 days
  ⚠ Follow up with Sarah about resume review                Overdue · 3 days

DUE THIS WEEK (1)
  ☐ Prepare tradeoff explanations (Supabase vs Firebase)     Due: Fri

WAITING ON OTHERS (2)
  ⏳ Alex will review your project — 12 days                 Alex Chen
  ⏳ Alex will send example case study — 12 days             Alex Chen

DUE LATER (1)
  ☐ Schedule follow-up check-in with Alex                    Due: Apr 28
```

The "Waiting on others" section is visually distinct — hourglass icon, muted urgency (no red), shows days elapsed rather than a due date. `waiting_on` items ONLY appear in this section (not in the due-date sections), even if they have a due date. `mutual` items appear in normal due-date sections with a handshake icon.

**Value:** At a glance, Dawson knows: "I have 2 overdue tasks I need to do, 1 due Friday, and 2 things I'm waiting on other people for." He can prioritize his own work and decide whether to nudge Alex.

---

### Story 6: Contact profile shows the full relationship picture

**Dawson views Alex's contact profile. The Actions tab shows:**

```
YOUR COMMITMENTS (1 of 2 done)
  ✓ Send Alex your CareerVine project for review     Completed Mar 20
  ☐ Write Medium articles about product decisions     No due date

WAITING ON ALEX (0 of 2 done)
  ⏳ Review your project and give feedback             12 days waiting
  ⏳ Send you an example product case study             12 days waiting

MUTUAL (1)
  ☐ Schedule follow-up check-in                       Due: Apr 28
```

**Value:** Before any conversation with Alex, Dawson can see the full picture: what he promised, what Alex promised, and what's outstanding. This is context no other tool gives you.

---

## Technical Design

### Data Model Changes

**New columns on `follow_up_action_items`:**

```sql
ALTER TABLE follow_up_action_items
  ADD COLUMN direction text DEFAULT 'my_task'
    CHECK (direction IN ('my_task', 'waiting_on', 'mutual')),
  ADD COLUMN assigned_speaker text,
  ADD COLUMN related_action_item_id integer REFERENCES follow_up_action_items(id) ON DELETE SET NULL;
```

- `direction` — `my_task` (default), `waiting_on`, `mutual`
- `assigned_speaker` — preserves the original speaker label from the transcript (currently extracted as `assigned_to` and thrown away after contact matching)
- `related_action_item_id` — optional link between paired items (e.g., your commitment and the corresponding waiting-on item). Used to show context like "You sent your project on Mar 20" on the waiting-on side when the my_task side is completed.
- Default of `my_task` means all existing items are backward compatible

**Type changes in `database.types.ts`:**

Add to the `follow_up_action_items` Row type:
```typescript
direction: string | null;       // 'my_task' | 'waiting_on' | 'mutual'
assigned_speaker: string | null; // Original speaker label from transcript
related_action_item_id: number | null; // FK to linked paired item
```

Insert type inherits these as optional (DB defaults handle them).

### Extraction Changes (Phase 1)

**Updated prompt for `extract-actions` route (`src/app/api/transcripts/extract-actions/route.ts`):**

The current prompt says "extract action items" generically. The new prompt will:

1. Extract commitments from ALL speakers, not just the user
2. Classify each by direction:
   - `my_task` — the user explicitly committed to doing something
   - `waiting_on` — the contact explicitly offered or committed to doing something for the user
   - `mutual` — both parties agreed to something together
3. Write titles from the user's perspective:
   - my_task: "Send Alex your project for review"
   - waiting_on: "Alex will review your project and give feedback"
   - mutual: "Schedule follow-up check-in with Alex in 4-6 weeks"
4. Be more thorough — catch follow-up messages, check-ins, and the other person's offers
5. For `mutual` items with vague date ranges like "4-6 weeks," resolve to the midpoint

**Updated JSON schema — add to `properties` and `required`:**
```json
"direction": {
  "type": "string",
  "enum": ["my_task", "waiting_on", "mutual"],
  "description": "Who owns this action: my_task = user committed, waiting_on = contact committed to do for user, mutual = both agreed"
}
```

Note: The existing `assigned_to` field (currently in the schema as `assigned_to`) maps to `assigned_speaker` in storage. No rename needed — the extraction schema uses `assigned_to`, the API response maps it to `assignedSpeaker`, and storage saves it as `assigned_speaker`.

**Updated response mapping (route handler lines ~112-130):**
```typescript
return {
  title: item.title,
  description: item.description || null,
  contactId: matched?.id ?? null,
  contactName: matched?.name ?? null,
  dueDate: resolveDueDate(item.due_date_hint, meetingDate),
  evidence: item.evidence,
  assignedSpeaker: item.assigned_to,
  direction: item.direction,  // NEW
};
```

### Transcript Suggestions UI (Phase 1)

**File: `src/components/meetings/transcript-action-suggestions.tsx`**

**Type change — add `direction` to `TranscriptSuggestion`:**
```typescript
interface TranscriptSuggestion {
  _key: string;
  title: string;
  description: string | null;
  contactId: number | null;
  contactName: string | null;
  dueDate: string | null;
  evidence: string;
  assignedSpeaker: string;
  direction: "my_task" | "waiting_on" | "mutual";  // NEW
}
```

**Rendering change — group by direction with inline editing:**

Replace the flat `suggestions.map(...)` with three sections:

```typescript
const myTasks = suggestions.filter(s => s.direction === "my_task");
const waitingOn = suggestions.filter(s => s.direction === "waiting_on");
const mutual = suggestions.filter(s => s.direction === "mutual");
```

Render each group with a section header and direction badge:
- "Your commitments" with CheckSquare icon
- "Waiting on {contactName}" with Hourglass icon (derive contact name from first item)
- "Mutual" with Handshake icon

**Inline editing — each suggestion card is editable before saving:**

Each card shows the AI-extracted values as editable fields:

```
┌──────────────────────────────────────────────────────────┐
│ [my_task ▾]  Send Alex your CareerVine project for...    │
│              ──────────────────────────────────────       │
│              (editable title - click to edit)             │
│                                                          │
│  📅 Mar 20, 2026  (click to change)    👤 Alex Chen      │
│                                                          │
│  "Feel free to send me anything you're working on"       │
│                                                [Add] [✕] │
└──────────────────────────────────────────────────────────┘
```

**Editable fields per suggestion:**
- **Title** — inline text input, click to edit, blur to save. Pre-filled with AI extraction.
- **Due date** — DatePicker component (the same one used elsewhere). Pre-filled if AI resolved a date, otherwise shows "Add due date" placeholder.
- **Direction** — small dropdown/select to change category (`my_task` / `waiting_on` / `mutual`). Pre-filled with AI classification. Changing direction moves the item to the correct section immediately.
- **Dismiss** (X) — removes the suggestion entirely.
- **Add** — saves with whatever edits the user made.

**What is NOT editable:**
- Evidence quote (this is a direct transcript reference, shouldn't be changed)
- Contact assignment (this is auto-matched from the transcript speaker — could be wrong, but editing it requires a contact picker which adds too much complexity here. The user can edit it after saving via the action item edit modal.)

**State management:**

Suggestions are stored in `useState<TranscriptSuggestion[]>`. Edits mutate the array in place:

```typescript
const updateSuggestion = (key: string, updates: Partial<TranscriptSuggestion>) => {
  setSuggestions(prev => prev.map(s =>
    s._key === key ? { ...s, ...updates } : s
  ));
};
```

When direction changes, the item re-sorts into the correct group on the next render (since groups are derived via `.filter()`).

When user clicks "Add", `acceptSuggestion` passes the current (possibly edited) values including `direction`, `assignedSpeaker`, `title`, and `dueDate` to `createActionItem`.

### Storage (Phase 2)

**Migration file: `supabase/migrations/YYYYMMDDHHMMSS_add_direction_to_action_items.sql`**

```sql
ALTER TABLE follow_up_action_items
  ADD COLUMN direction text DEFAULT 'my_task'
    CHECK (direction IN ('my_task', 'waiting_on', 'mutual')),
  ADD COLUMN assigned_speaker text,
  ADD COLUMN related_action_item_id integer REFERENCES follow_up_action_items(id) ON DELETE SET NULL;
```

**`database.types.ts` update:**

Add to `follow_up_action_items` Row:
```typescript
direction: string | null;
assigned_speaker: string | null;
related_action_item_id: number | null;
```

**`createActionItem` in `queries.ts` (line 604-628):**

No signature change needed — it accepts the full Insert type via `Database["public"]["Tables"]["follow_up_action_items"]["Insert"]`. Adding columns to the type automatically makes them available. Existing callers that don't pass `direction` get the DB default `'my_task'`.

**All 6 existing call sites verified — none will break:**
1. `transcript-action-suggestions.tsx` → will be updated to pass `direction` + `assigned_speaker`
2. `action-items/page.tsx` → manual creation, defaults to `my_task`
3. `contact-actions-tab.tsx` → manual creation, defaults to `my_task`
4. `quick-capture-modal.tsx` → defaults to `my_task`
5. `suggestions/save/route.ts` → defaults to `my_task`
6. `meetings/page.tsx` → defaults to `my_task`

**`acceptSuggestion` in `transcript-action-suggestions.tsx` (line 82-114):**

Update to pass new fields:
```typescript
await createActionItem({
  ...existingFields,
  direction: suggestion.direction,           // NEW
  assigned_speaker: suggestion.assignedSpeaker, // NEW (was extracted but discarded)
}, contactIds);
```

**Linked item pairing:**

When the user saves transcript action items, if a `my_task` and a `waiting_on` item reference the same topic (e.g., "Send project to Alex" and "Alex will review project"), they should be linked via `related_action_item_id`. The extraction prompt can identify pairs by adding a `pair_key` field — items with the same `pair_key` are linked. After saving all items, a second pass links them:

```typescript
// After all items are saved, link paired items
for (const [key, ids] of pairMap) {
  if (ids.length === 2) {
    await updateActionItem(ids[0], { related_action_item_id: ids[1] });
    await updateActionItem(ids[1], { related_action_item_id: ids[0] });
  }
}
```

### Display Updates (Phase 3)

**Action items page (`action-items/page.tsx`):**

**Query change:** `getActionItems(userId)` already returns all pending items. Add `direction` to the select if not already included (the function selects `*` so it should be automatic once the column exists). Verify by checking the query in `queries.ts`.

**Filtering change:** Split items into two groups before rendering:
```typescript
const myItems = actionItems.filter(i => i.direction !== "waiting_on");
const waitingItems = actionItems.filter(i => i.direction === "waiting_on");
```

- `myItems` go through the existing overdue/this-week/later/no-date grouping
- `waitingItems` render in a new "Waiting on others" section with:
  - Hourglass icon + section header
  - Each item shows: title, contact name, days elapsed since `created_at`
  - Muted styling (not red even if old — these aren't your fault)
  - "Mark done" still available (for when they deliver)
- `mutual` items (direction === `'mutual'`) remain in the normal due-date sections with a small handshake icon badge

**Home page dashboard (`page.tsx`):**

**Filtering change:** The `getActionItems(user.id)` query returns all items. Client-side filter:
```typescript
const myActionItems = actionItems.filter(i => i.direction !== "waiting_on");
const waitingOnCount = actionItems.filter(i => i.direction === "waiting_on").length;
```

- "Pending follow-ups" section shows only `my_task` and `mutual` items (exclude `waiting_on`)
- Below the pending section, if `waitingOnCount > 0`, show a compact indicator:
  ```
  ⏳ Waiting on 2 responses  →
  ```
  Clicking navigates to the action-items page (which shows the full "Waiting on others" section)

**Contact profile actions tab (`contact-actions-tab.tsx`):**

**Type changes:** Add `direction` to the `ActionItem` type (line 17-26) and `CompletedAction` type (line 28-35):
```typescript
type ActionItem = ... & {
  direction: string | null;
  related_action_item_id: number | null;
};
```

**Query changes:** `getActionItemsForContact` and `getCompletedActionItemsForContact` need to return `direction` and `related_action_item_id`. These likely select `*` already, so adding the column to the DB should be sufficient. Verify by checking the queries.

**Rendering change:** Replace the flat list with three grouped sections:

```typescript
const myPending = actions.filter(a => a.direction !== "waiting_on" && a.direction !== "mutual");
const waitingPending = actions.filter(a => a.direction === "waiting_on");
const mutualPending = actions.filter(a => a.direction === "mutual");

// Same for completed items
const myCompleted = completedActions.filter(a => a.direction !== "waiting_on" && a.direction !== "mutual");
const waitingCompleted = completedActions.filter(a => a.direction === "waiting_on");
const mutualCompleted = completedActions.filter(a => a.direction === "mutual");
```

Each section shows:
- Header: "Your commitments (1 of 2 done)" / "Waiting on {contactName} (0 of 2 done)" / "Mutual (1)"
- Progress is computed as `completed.length` of `(completed.length + pending.length)` per direction group
- "Waiting on" items show days elapsed since creation rather than due date
- Linked item context: if a `waiting_on` item has a `related_action_item_id` that is completed, show "You completed your part on {date}" below the title

### "Waiting On" Nudge Generator (Phase 4)

**New constant in `src/lib/constants.ts`:**
```typescript
export const SuggestionReasonType = {
  ...existing,
  WaitingOnNudge: "waiting_on_nudge",
} as const;
```

**New generator in `src/lib/ai-followup/generate-suggestions.ts`:**

`generateWaitingOnNudgeSuggestions` is a rule-based generator, but unlike the existing generators (which operate on `SuggestionContact[]`), it needs action item data. This requires a separate query.

**Data fetching approach:** The orchestrator (`generateSuggestions`) will fetch waiting-on items separately and pass them as a parameter:

```typescript
// In the orchestrator, alongside existing fetches:
const [contacts, existingAiItems, waitingOnItems] = await Promise.all([
  fetchSuggestionCandidates(userId),
  // ...existing query...,
  service
    .from("follow_up_action_items")
    .select("id, contact_id, title, suggestion_evidence, created_at, contacts(name, photo_url, industry)")
    .eq("user_id", userId)
    .eq("direction", "waiting_on")
    .eq("is_completed", false),
]);
```

**Generator function:**

```typescript
export function generateWaitingOnNudgeSuggestions(
  waitingOnItems: WaitingOnItem[],
  contactEmails: Map<number, string[]>,  // to check if contact has email
  today: Date = new Date(),
): Suggestion[]
```

Trigger conditions:
- Item is `waiting_on` and not completed (already filtered by query)
- `created_at` is >7 days ago
- Contact has at least one email (so the nudge can lead to an email)

Output per qualifying item:
- `id`: `"waitnudge-{item.id}"`
- `headline`: `"{contactName} offered to {truncated title} {N} days ago"`
- `suggestedTitle`: `"Send {contactName} a friendly check-in"`
- `suggestedDescription`: `"They offered {N} days ago — a brief, polite follow-up goes a long way"`
- `evidence`: the original `suggestion_evidence` from the transcript
- `score`: 70
- `reasonType`: `SuggestionReasonType.WaitingOnNudge`

**Wiring into orchestrator (line ~413-418):**

```typescript
const allRuleBased = [
  ...generateGraduationSuggestions(contacts, today),
  ...generateNoInteractionCadenceSuggestions(contacts),
  ...generateFirstTouchSuggestions(contacts, today),
  ...generateDecayWarningSuggestions(contacts),
  ...generateWaitingOnNudgeSuggestions(waitingOnItems, contactEmailsMap, today), // NEW
];
```

**Email drafting connection — how the nudge leads to an email:**

When the user acts on a nudge suggestion, it works through the existing flows:

1. **"Did it" (checkmark)** → calls `completeSuggestion` → creates a completed action item (records that the user followed up). This is enough if they already sent a message manually.

2. **"Save" (bookmark)** → saves as a pending action item. The user can then go to the contact profile and use "Compose email" to send a follow-up.

3. **For a more direct path:** On the home page, nudge suggestions can include the contact's email. When rendered, the suggestion card can show a "Compose" button (similar to the AI draft "Review & Send" button that already exists on reach-out-today cards). Clicking it opens the Compose Email modal via `openCompose({ to: contactEmail, name: contactName })` from the existing `useCompose` context. The user sees the compose modal pre-filled with the contact's email and can write (or have AI write) their follow-up.

This does NOT require generating an `ai_follow_up_drafts` row. It uses the simpler `openCompose` path which opens a blank compose modal with the recipient pre-filled. The user can then click "AI Write" inside the compose modal to get an AI-drafted message using the existing `ai-write` endpoint.

---

## Implementation Order

| Phase | What | Files | Effort |
|-------|------|-------|--------|
| 1 | Extraction with direction + update transcript suggestions UI | extract-actions route, transcript-action-suggestions component | Medium |
| 2 | Database migration + storage + linked item pairing | migration, database.types, queries, transcript-action-suggestions (save + pairing) | Medium |
| 3 | Display on action-items page, home page, contact profile | action-items page, home page, contact-actions-tab | Medium |
| 4 | "Waiting on" nudge suggestion generator | generate-suggestions, constants, tests | Medium |

Phases 1-2 should ship together (extraction is useless without storage). Phase 3 can ship independently. Phase 4 is the capstone that makes the whole system pay for itself.

---

## Files to modify (complete list)

### Phase 1
- `src/app/api/transcripts/extract-actions/route.ts` — prompt, schema, response mapping
- `src/components/meetings/transcript-action-suggestions.tsx` — type, grouping, display

### Phase 2
- `supabase/migrations/YYYYMMDDHHMMSS_add_direction_to_action_items.sql` — new migration
- `src/lib/database.types.ts` — add direction, assigned_speaker, related_action_item_id to Row/Insert types
- `src/components/meetings/transcript-action-suggestions.tsx` — save direction + assigned_speaker, pair linked items

### Phase 3
- `src/app/action-items/page.tsx` — filter waiting_on into separate section, add "Waiting on others" UI
- `src/app/page.tsx` — filter waiting_on out of pending, add "Waiting on N responses" indicator
- `src/components/contacts/contact-actions-tab.tsx` — group by direction, show progress, linked item context
- `src/lib/queries.ts` — verify getActionItems, getActionItemsForContact, getCompletedActionItemsForContact return direction (likely automatic if selecting *)

### Phase 4
- `src/lib/constants.ts` — add WaitingOnNudge to SuggestionReasonType
- `src/lib/ai-followup/generate-suggestions.ts` — new generator function, orchestrator query + wiring
- `src/lib/ai-followup/suggestion-types.ts` — WaitingOnItem type (if separate from SuggestionContact)
- `src/__tests__/suggestion-generators.test.ts` — tests for nudge generator
- `src/app/page.tsx` — nudge suggestion cards with "Compose" button for direct email path

---

## What makes this genuinely valuable

1. **It solves a real problem nobody else solves** — No personal CRM tracks "waiting on" items with AI-generated follow-up nudges
2. **It uses infrastructure you already have** — AI extraction, suggestion engine, email composition
3. **It changes behavior** — Users will actually follow up on promises made to them, strengthening relationships
4. **It's backward compatible** — Existing action items default to `my_task` and work exactly as before
5. **The value compounds** — Over months of networking, the "waiting on" nudges recover dozens of forgotten offers and opportunities

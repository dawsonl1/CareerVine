# AI-Extracted Action Items from Transcripts

## Problem

After a user creates a meeting with a transcript (via paste, file upload, or audio transcription), they have to manually identify and create action items. This is tedious and easy to miss — the whole point of recording a conversation is to not lose track of commitments.

## Solution

After a transcript is saved on a meeting, automatically send it to OpenAI to extract action items. The AI identifies commitments, follow-ups, and tasks mentioned in the conversation, assigns them to the appropriate meeting attendees, and suggests due dates when mentioned. Results are presented as suggestions the user can accept, edit, or dismiss — never auto-created without user confirmation.

## UX Flow

```
1. User saves a meeting with a transcript
2. A "Suggested action items" section appears below the transcript
3. Shows a loading shimmer while AI processes (~2-3 seconds)
4. AI suggestions appear as cards with:
   - Title (e.g., "Send resume to hiring manager")
   - Assigned contact (auto-matched from meeting attendees)
   - Due date (if mentioned in conversation, e.g., "by Friday")
   - Evidence quote (the transcript excerpt that triggered this)
5. Each suggestion has: [Add] [Edit & Add] [Dismiss]
6. Clicking "Add" creates the action item immediately
7. Clicking "Edit & Add" opens the standard action item form pre-filled
8. Dismissed suggestions are hidden (not persisted)
```

## Why Suggestions, Not Auto-Create

- Users should always feel in control of their task list
- AI extraction is imperfect — false positives (social pleasantries like "let's grab coffee sometime") would clutter the list
- The suggestion pattern already exists in the codebase (smart follow-up suggestions) so users have a familiar mental model
- Matches the `source: "ai_suggestion"` field already on the action items table

---

## Architecture

### Data Flow

```
Meeting saved with transcript
        ↓
Client calls POST /api/transcripts/extract-actions
        ↓
API route reads transcript text + meeting attendees
        ↓
OpenAI extracts action items with structured output (JSON schema)
        ↓
Response mapped to suggestion objects with contact matching
        ↓
Client renders suggestions in-line below transcript
        ↓
User accepts → createActionItem() with source: "ai_suggestion"
```

### Why Client-Triggered, Not Server-Side

- Matches existing patterns (transcript parsing, email AI writing)
- No background job infrastructure exists in the app
- User sees results immediately in context
- No need for webhooks, polling, or real-time subscriptions

### Contact Assignment Logic

The AI returns speaker names from the transcript. The API route matches them to meeting attendees:

1. **Exact match** — speaker name matches a contact name on the meeting
2. **Fuzzy match** — speaker first name matches a contact first name (handles "John" vs "John Smith")
3. **"I/me/we" detection** — statements by the user themselves (the app owner) are assigned to the contact they're talking to, since the user is the one who needs to follow through
4. **Unresolved** — if no match, the suggestion is still shown but without a pre-assigned contact. User can assign manually when adding.

---

## Detailed Changes

### 1. New API Route: `POST /api/transcripts/extract-actions`

**File:** `src/app/api/transcripts/extract-actions/route.ts`

**Input:**
```typescript
{
  meetingId: number,
  transcript: string,           // raw transcript text
  attendeeNames: string[],      // names of contacts on the meeting
  attendeeIds: number[],        // corresponding contact IDs
  userName: string,             // the app user's name (for "I/me" detection)
}
```

**OpenAI prompt strategy:**
- System prompt explains the role: "You are analyzing a meeting transcript to extract action items — specific commitments, tasks, follow-ups, or deliverables that someone agreed to do."
- Key instruction: distinguish between concrete commitments ("I'll send you that report by Thursday") and vague social niceties ("we should catch up sometime"). Only extract the former.
- Structured output via JSON schema enforces the response shape.

**OpenAI JSON schema:**
```typescript
{
  action_items: [{
    title: string,              // concise task description
    description: string | null, // additional context
    assigned_to: string,        // speaker name who committed to this
    due_date_hint: string | null, // relative date mentioned ("by Friday", "next week", "end of month")
    evidence: string,           // exact quote from transcript
  }]
}
```

**Post-processing (server-side):**
- Match `assigned_to` to attendee names → resolve `contact_id`
- Convert `due_date_hint` to an actual date relative to the meeting date
- Detect when the assigned speaker is the user themselves → assign to the contact they're addressing (since the user owns all action items)
- Return suggestions array ready for client rendering

**Response:**
```typescript
{
  suggestions: [{
    title: string,
    description: string | null,
    contactId: number | null,     // resolved from attendee matching
    contactName: string | null,
    dueDate: string | null,       // ISO date string
    evidence: string,             // transcript quote
    assignedSpeaker: string,      // raw speaker name from AI
  }]
}
```

### 2. New Component: `TranscriptActionSuggestions`

**File:** `src/components/meetings/transcript-action-suggestions.tsx`

**Props:**
```typescript
{
  meetingId: number,
  userId: string,
  transcript: string,
  attendees: { id: number; name: string }[],
  onActionCreated: () => void,  // callback to reload action items
}
```

**Behavior:**
- On mount (or when `transcript` changes), calls the extraction API
- Shows loading shimmer (3-4 skeleton cards) during API call
- Renders suggestion cards with accept/edit/dismiss controls
- Accepted suggestions call `createActionItem()` with:
  - `meeting_id: meetingId`
  - `source: "ai_suggestion"`
  - `suggestion_headline: evidence` (reuse existing column)
- Dismissed suggestions are removed from local state (not persisted)
- If all suggestions are handled (accepted or dismissed), show a "No more suggestions" message
- If API returns 0 suggestions, show "No action items found in this transcript"
- If API errors, show an inline error with retry button

**Visual design:**
- Appears below the transcript viewer in the meeting detail view
- Cards use the existing M3 card component with `variant="tonal"`
- Each card shows: title, contact chip (if assigned), due date chip (if present), and evidence quote in muted text
- Action buttons: filled "Add" button, text "Edit" button, ghost dismiss (X) button

### 3. Integrate into Meetings Page

**File:** `src/app/meetings/page.tsx`

**Where it appears:**
- In the meeting detail/expanded view, below the transcript viewer
- Only shown when the meeting has a transcript (`meeting.transcript` is non-empty)
- Trigger: appears after saving a meeting with a transcript, or when viewing an existing meeting that has a transcript

**Auto-trigger vs. manual:**
- When a meeting is first saved with a transcript, automatically trigger extraction
- When viewing an existing meeting, show a "Suggest action items" button that triggers on click (don't auto-call on every view — it costs API tokens)
- Cache: store suggestions in component state keyed by meeting ID so re-expanding a meeting card doesn't re-call the API

### 4. Add Constants

**File:** `src/lib/constants.ts`

Add new suggestion reason type:
```typescript
export const SuggestionReasonType = {
  // ... existing
  TranscriptExtracted: "transcript_extracted",
} as const;
```

Add new action item source:
```typescript
export const ActionItemSource = {
  Manual: "manual",
  AiSuggestion: "ai_suggestion",
  AiTranscript: "ai_transcript",  // new
} as const;
```

---

## Edge Cases

### Long transcripts
- OpenAI has token limits. The existing transcript parse route truncates at 50,000 characters. Use the same limit here.
- For very long transcripts (>50k chars), truncation may miss action items from the end. Show a warning: "This transcript was truncated for analysis. Action items near the end may not be detected."

### No attendees on meeting
- If no contacts are linked to the meeting, AI can still extract action items. They just won't have a pre-assigned contact. The user assigns when adding.

### Duplicate detection
- Before showing suggestions, check if a suggested action item title closely matches an existing action item already linked to this meeting. If so, mark it as "Already added" and visually de-emphasize it.

### Speaker-to-contact matching ambiguity
- Transcripts from audio (Deepgram) use "Speaker 0", "Speaker 1" labels by default unless the SpeakerResolver component was used. In this case, check `transcript_segments` for resolved `contact_id` values and use those for attribution.
- If speakers aren't resolved, fall back to the raw speaker labels and let the user assign contacts manually.

### Due date resolution
- "By Friday" → next Friday from meeting date
- "Next week" → Monday of the following week from meeting date
- "End of month" → last day of the meeting's month
- No hint → no due date (null)
- This logic runs server-side in the API route, not in the AI — the AI just extracts the raw hint text.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/app/api/transcripts/extract-actions/route.ts` | **Create** | API route for AI extraction |
| `src/components/meetings/transcript-action-suggestions.tsx` | **Create** | Suggestion cards component |
| `src/lib/constants.ts` | **Modify** | Add TranscriptExtracted reason type and AiTranscript source |
| `src/lib/api-schemas.ts` | **Modify** | Add Zod schema for extract-actions input validation |
| `src/app/meetings/page.tsx` | **Modify** | Integrate suggestion component into meeting detail view |

**Tests:**

| File | Action | Description |
|------|--------|-------------|
| `src/__tests__/extract-actions-helpers.test.ts` | **Create** | Test contact matching, due date resolution, dedup logic |

---

## Implementation Order

1. **API route** — build and test the OpenAI extraction endpoint in isolation
2. **Contact matching + due date helpers** — pure functions, easy to test
3. **Suggestion component** — build the UI cards with accept/edit/dismiss
4. **Meetings page integration** — wire the component into the meeting detail view
5. **Testing** — unit tests for helpers, manual E2E testing with real transcripts

---

## What This Doesn't Do

- **No auto-creation** — suggestions require user confirmation. This is a deliberate UX choice, not a limitation.
- **No real-time extraction** — doesn't process as the user types/pastes. Only runs after the meeting is saved.
- **No meeting summary** — only extracts action items, not a meeting summary or notes. Summary could be a separate feature.
- **No recurring analysis** — doesn't re-analyze transcripts that were already processed. One extraction per transcript.

---

## Cost Estimate

The full transcript is sent as input, so cost scales with meeting length.

| Meeting length | Input tokens | Estimated cost |
|---------------|-------------|---------------|
| 15 min        | ~5,000      | ~$0.003       |
| 30 min        | ~10,000     | ~$0.005       |
| 1 hour        | ~20,000     | ~$0.01        |
| 2 hours       | ~40,000     | ~$0.02        |

Based on OpenAI gpt-5-mini pricing ($0.40/1M input, $1.60/1M output). Still negligible compared to Deepgram audio transcription ($0.25/hour). Only runs when triggered by user action — not on every page view.

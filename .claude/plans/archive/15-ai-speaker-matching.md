# AI-Powered Speaker Matching for Transcripts

**Finding addressed:** #11 (AI should auto-match speakers instead of manual linking)

---

## Problem Summary

When a transcript is uploaded, speakers are identified by labels (e.g., "Speaker 1", "John", "Speaker A") and users must manually link each speaker to a contact using dropdown menus. This is tedious, especially for transcripts with many speakers.

## Current Speaker Matching Flow

### Transcript Upload → Speaker Detection
- **Audio files**: Deepgram `nova-3` with `diarize: true` → speakers labeled as "Speaker 0", "Speaker 1", etc.
- **Text files/paste**: Client-side parser extracts speaker names from format (e.g., "John Smith:", "Speaker A")
- **LLM fallback**: OpenAI parses unstructured text into speaker turns

### Speaker Resolution (`src/components/speaker-resolver.tsx`)
- Manual dropdown UI for each unique speaker label
- **Existing heuristic auto-matching:**
  - Exact name match (case-insensitive)
  - First-name match (unambiguous — only one contact named "John")
  - Partial containment (speaker label contains contact name or vice versa)
- Meeting attendees shown first in dropdown, then other contacts (up to 50)
- User confirms all mappings via "Save mappings" button

### Database
- `transcript_segments` table has nullable `contact_id` FK
- `updateSpeakerContact(meetingId, speakerLabel, contactId)` updates all segments for a speaker

### Existing AI Infrastructure
- OpenAI client configured (`src/lib/openai.ts`) with structured output support
- Action item extraction already does basic `matchSpeakerToAttendee()` (`src/lib/transcript-action-helpers.ts`)
- Contact data fully loaded at resolution time

## Proposed Solution

### 1. AI-Powered Speaker Matching API

Create a new API endpoint that uses OpenAI to intelligently match speaker labels to contacts.

**Endpoint:** `POST /api/transcripts/match-speakers`

**Request:**
```json
{
  "meetingId": 123,
  "speakerLabels": ["Speaker 0", "Speaker 1", "John"],
  "speakerSamples": {
    "Speaker 0": "So I was thinking about the Q3 roadmap...",
    "Speaker 1": "Yeah, I agree. Let me check with the design team.",
    "John": "I'll follow up with the client by Friday."
  },
  "attendeeIds": [45, 67, 89],
  "contactContext": [
    { "id": 45, "name": "Sarah Chen", "role": "Product Manager", "company": "Acme Corp" },
    { "id": 67, "name": "John Park", "role": "Designer", "company": "Acme Corp" },
    { "id": 89, "name": "Mike Johnson", "role": "Account Manager", "company": "ClientCo" }
  ]
}
```

**Response:**
```json
{
  "matches": [
    { "speakerLabel": "Speaker 0", "contactId": 45, "confidence": 0.85, "reason": "Discusses roadmap — matches Product Manager role" },
    { "speakerLabel": "Speaker 1", "contactId": 67, "confidence": 0.7, "reason": "References design team — matches Designer role" },
    { "speakerLabel": "John", "contactId": 67, "confidence": 0.95, "reason": "Name match: John → John Park" }
  ]
}
```

**Implementation:**
- Extract sample text (first 2-3 utterances per speaker, ~200 words each) for context
- Build prompt with speaker samples + contact profiles (name, role, company, emails)
- Use OpenAI structured output with JSON schema for guaranteed response format
- Include confidence scores so the UI can highlight uncertain matches

### 2. Matching Strategy (Layered)

Apply matching in layers, using the cheapest/fastest method first:

**Layer 1: Deterministic matching (no API call)**
- Exact name match (existing)
- First-name match when unambiguous (existing)
- Email-based match (new — if speaker label contains an email that matches a contact)

**Layer 2: AI matching (API call, only for unmatched speakers)**
- Send only unresolved speaker labels to OpenAI
- Include:
  - Speaker samples (transcript excerpts)
  - Meeting attendee list with roles/companies
  - All contacts for broader matching
  - Meeting title/notes for additional context
- Use `gpt-4o-mini` for cost efficiency (structured output)

**Layer 3: User confirmation (always)**
- Show all matches (deterministic + AI) with confidence indicators
- High confidence (>0.8): Pre-selected, shown with green indicator
- Medium confidence (0.5-0.8): Pre-selected but shown with yellow "verify" indicator
- Low confidence (<0.5): Not pre-selected, shown as suggestion
- User can override any match before saving

### 3. Enhanced Speaker Resolver UI

Update `src/components/speaker-resolver.tsx` to support AI matching:

**New flow:**
1. Transcript is parsed → speaker labels extracted
2. Deterministic matching runs immediately (Layer 1)
3. "Auto-match with AI" button appears for remaining unmatched speakers
4. On click → calls `/api/transcripts/match-speakers` (Layer 2)
5. Loading state: "Analyzing transcript to identify speakers..."
6. Results appear with confidence indicators
7. User reviews and confirms all mappings (Layer 3)

**UI enhancements:**
- Confidence badges: 🟢 High / 🟡 Medium / ⚪ Unmatched
- "Why?" tooltip showing the AI's reasoning for each match
- "Auto-match all" button that runs AI matching for all speakers at once
- Keep manual dropdown as fallback for overrides

### 4. Automatic Matching on Upload (Optional Enhancement)

For a smoother UX, run AI matching automatically after transcript parsing:

- After transcript is parsed and speakers are detected, automatically run Layer 1 + Layer 2
- Show the Speaker Resolver with all matches pre-filled
- User just reviews and clicks "Save mappings"
- Add a setting to disable automatic AI matching (for cost-conscious users)

---

## Files to Modify/Create

| File | Changes |
|------|---------|
| New: `src/app/api/transcripts/match-speakers/route.ts` | New API endpoint for AI speaker matching |
| `src/components/speaker-resolver.tsx` | Add AI matching button, confidence indicators, reasoning tooltips |
| `src/lib/transcript-action-helpers.ts` | Extend `matchSpeakerToAttendee()` with email-based matching |
| `src/lib/queries.ts` | Add query to fetch contact context (name, role, company, emails) for matching |
| `src/app/meetings/page.tsx` | Wire up auto-matching trigger after transcript parse |
| `src/components/transcript-uploader.tsx` | Potentially trigger matching after upload completes |

## OpenAI Prompt Design

The prompt should:
- Provide clear instructions: "Match these speaker labels to the most likely contact"
- Include speaker samples for context clues (role references, topic expertise, name mentions)
- Include full contact profiles (name, role, company) for matching signals
- Request confidence scores and reasoning
- Handle edge cases: unknown speakers (not in contacts), multiple possible matches, "me" / "I" references

**Cost estimate:** ~500-1000 tokens per matching request with 3-5 speakers and 10-20 contacts. At GPT-4o-mini pricing, this is fractions of a cent per transcript.

## Testing

- Verify deterministic matching still works (no regression)
- Verify AI matching correctly identifies speakers by name, role context, and topic
- Verify confidence scores are reasonable
- Verify low-confidence matches are not pre-selected
- Verify user can override AI matches
- Verify matching works with Deepgram-style labels ("Speaker 0", "Speaker 1")
- Verify matching works with named labels ("John", "Sarah Chen")
- Verify cost: check token usage is reasonable
- Run `npm run test` for regressions

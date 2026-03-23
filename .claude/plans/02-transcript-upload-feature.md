# Transcript Upload & Transcription Feature

## Overview

Allow users to upload meeting recordings or text transcripts. The app transcribes audio (via Deepgram), parses text transcripts, detects speakers, and saves structured speaker-attributed segments linked to both the meeting and contacts.

---

## Current State

- `meetings.transcript` column exists (plain text, nullable)
- Supabase Storage bucket `attachments` with RLS is set up
- Full attachment system exists (upload, link to meetings/contacts/interactions)
- OpenAI SDK integrated (for profile parsing + AI email writing)
- Meeting form has a plain `<textarea>` for transcript entry
- Meeting card displays transcript as raw `whitespace-pre-wrap` text

---

## Phase 1: Schema + Deepgram Integration + Parser Module

### 1A. Database Migration

**New table: `transcript_segments`**

```sql
CREATE TABLE transcript_segments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  speaker_label TEXT NOT NULL,       -- raw label from transcript ("Speaker 1", "John", etc.)
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  started_at  REAL,                  -- seconds from start of meeting (nullable)
  ended_at    REAL,                  -- seconds from end of segment (nullable)
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
-- RLS: user can access segments where they own the parent meeting
-- Policies for SELECT, INSERT, UPDATE, DELETE

CREATE INDEX idx_transcript_segments_meeting ON transcript_segments(meeting_id, ordinal);
```

**New columns on `meetings`**:

```sql
ALTER TABLE meetings ADD COLUMN transcript_source TEXT;
  -- 'paste', 'upload_txt', 'upload_vtt', 'upload_pdf', 'audio_deepgram'
ALTER TABLE meetings ADD COLUMN transcript_parsed BOOLEAN DEFAULT FALSE;
ALTER TABLE meetings ADD COLUMN transcript_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL;
```

### 1B. Deepgram Integration (Audio/Video Transcription)

**New dependency:** `@deepgram/sdk`

**New API route: `POST /api/transcripts/transcribe`**

Flow:
1. Client uploads audio/video file to Supabase Storage via existing attachment system
2. Client calls this endpoint with `{ attachmentId, meetingId }`
3. Server gets a signed URL for the file from Supabase Storage
4. Server sends the URL to Deepgram's `pre-recorded` API with:
   - `model: "nova-3"` (latest, best accuracy)
   - `diarize: true` (speaker detection)
   - `punctuate: true`
   - `paragraphs: true`
   - `smart_format: true`
   - `utterances: true` (groups words into speaker turns)
5. Deepgram returns utterances with `speaker` labels (integer IDs), timestamps, and text
6. Server maps utterances → `transcript_segments` rows
7. Server stores raw text concatenation in `meetings.transcript` (for search/backward compat)
8. Server saves segments to `transcript_segments` table
9. Returns segments to client

**Supported formats:** .mp3, .m4a, .wav, .ogg, .flac, .mp4, .webm, .mov

**Cost:** ~$0.25/hour of audio (Deepgram Nova-2 pay-as-you-go)

### 1C. Client-Side Text Transcript Parser

**New file: `src/lib/transcript-parser.ts`**

Pure function module — no React, no DB calls. Fully testable with Vitest.

```typescript
parseTranscript(rawText: string): ParseResult
// Returns: { segments: TranscriptSegment[], format: string, confidence: number }
```

**Supported formats (regex patterns):**
- Zoom: `HH:MM:SS Speaker Name: text`
- Google Meet: `Speaker Name\nHH:MM:SS\ntext`
- MS Teams: `HH:MM:SS -- Speaker Name\ntext`
- Otter.ai: `Speaker Name  HH:MM:SS\ntext`
- VTT with speaker tags: `<v Speaker Name>text`
- SRT with speaker prefixes
- Generic: `Speaker: text` (no timestamps)

**Confidence scoring:** % of lines that matched a detected pattern. If < 60%, flag for LLM fallback.

### 1D. LLM Fallback Parser

**New API route: `POST /api/transcripts/parse`**

Called only when client-side regex confidence is low.

- Input: `{ rawText: string }`
- Uses existing OpenAI integration with structured output (Zod schema)
- Prompt asks LLM to extract speaker turns from unstructured text
- Returns same `TranscriptSegment[]` shape as regex parser

### 1E. PDF Text Extraction

**New dependency:** `pdf-parse`

**New API route: `POST /api/transcripts/extract-pdf`**

- Input: FormData with PDF file
- Extracts text via `pdf-parse`
- Returns `{ text: string }` for client to run through the parser

### 1F. Query Functions (in `queries.ts`)

```
createTranscriptSegments(meetingId, segments[])   -- bulk insert
getTranscriptSegments(meetingId)                   -- ordered by ordinal
updateSegmentContact(segmentId, contactId)         -- speaker resolution
deleteTranscriptSegments(meetingId)                -- clear all (for re-parse)
updateMeetingTranscriptMeta(meetingId, { transcript_source, transcript_parsed, transcript_attachment_id })
```

### 1G. Tests

- `transcript-parser.test.ts` — test each format with real sample transcripts
- Test confidence scoring, edge cases (empty input, single speaker, no timestamps)
- Test segment ordering and timestamp extraction

---

## Phase 2: Upload + Display Components

### 2A. `TranscriptUploader` Component

**New file: `src/components/transcript-uploader.tsx`**

Replaces the current plain `<textarea>` in the meeting form. Four input modes via tabs/toggle:

1. **Paste** — textarea (preserves current behavior)
2. **Upload text** — file input for .txt, .vtt, .srt (read client-side with FileReader)
3. **Upload PDF** — file input for .pdf (sent to extract-pdf endpoint, then parsed)
4. **Upload recording** — file input for audio/video files (sent to transcribe endpoint)

After input:
- Text modes: runs client-side parser, shows preview of detected segments
- Audio mode: shows upload progress → "Transcribing..." state → segments when done
- If regex confidence is low, automatically calls LLM fallback

### 2B. `TranscriptViewer` Component

**New file: `src/components/transcript-viewer.tsx`**

Replaces the raw `<p>` block in meeting card and contact detail views.

- Renders parsed segments with:
  - Speaker name in bold, color-coded per speaker (small M3 palette)
  - Timestamp in muted text (formatted as MM:SS or HH:MM:SS)
  - Content as normal text
  - Contact avatar/link next to resolved speakers
- Collapsible if transcript is long (show first N segments + "Show more")
- Falls back to raw text display if no parsed segments exist (backward compat)

### 2C. Integration Points

- `/meetings/page.tsx`: Replace transcript textarea in form with `TranscriptUploader`; replace transcript display in card with `TranscriptViewer`
- `ContactMeetingsTab`: Use `TranscriptViewer` when rendering meeting transcripts within a contact's view

---

## Phase 3: Speaker Resolution

### 3A. `SpeakerResolver` Component

**New file: `src/components/speaker-resolver.tsx`**

Shown after a transcript is parsed (either inline or as a modal). Displays:

- List of unique speaker labels detected in the transcript
- For each label: a dropdown to select from meeting attendees, or "Unknown"
- Auto-mapping logic:
  1. Exact match on contact name (case-insensitive)
  2. First-name match against meeting attendees
  3. "Me" / "You" heuristics (map to the logged-in user's name if applicable)
- User confirms or adjusts, then saves `contact_id` on all matching segments

### 3B. Contact-Level Transcript View

On a contact's detail page, show a filtered view of transcripts where `contact_id` matches — so users can see everything a specific person has said across all meetings.

---

## Phase 4: Backfill Existing Transcripts (Optional)

- Button on individual meetings: "Re-parse transcript" — runs the existing raw text through the parser
- Bulk option in settings: "Parse all existing transcripts"
- Populates `transcript_segments` from existing `meetings.transcript` text

---

## Environment Setup

```
# .env.local
DEEPGRAM_API_KEY=<key>
```

---

## File Manifest

### New files:
- `supabase/migrations/YYYYMMDD_transcript_segments.sql`
- `careervine/src/lib/transcript-parser.ts`
- `careervine/src/lib/transcript-parser.test.ts`
- `careervine/src/components/transcript-uploader.tsx`
- `careervine/src/components/transcript-viewer.tsx`
- `careervine/src/components/speaker-resolver.tsx`
- `careervine/src/app/api/transcripts/transcribe/route.ts`
- `careervine/src/app/api/transcripts/parse/route.ts`
- `careervine/src/app/api/transcripts/extract-pdf/route.ts`
- `careervine/src/lib/api-schemas.ts` (add new schemas)

### Modified files:
- `careervine/src/lib/queries.ts` (add transcript segment CRUD)
- `careervine/src/lib/types.ts` (add TranscriptSegment type)
- `careervine/src/lib/database.types.ts` (regenerate after migration)
- `careervine/src/app/meetings/page.tsx` (integrate uploader + viewer)
- `careervine/package.json` (add @deepgram/sdk, pdf-parse)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transcription service | Deepgram (Nova-3) | Cheapest (~$0.25/hr), built-in diarization, single API call |
| Text parsing location | Client-side first, LLM fallback | Free + instant for 80%+ of cases |
| Segment storage | Dedicated table (not JSON) | Queryable by contact, easy speaker resolution updates |
| Raw text preserved | Yes, in `meetings.transcript` | Backward compat, full-text search, re-parseable |
| Audio processing | Server-side via API route | Needs Deepgram API key, file access via signed URL |
| No separate page | Transcripts accessed through meetings/contacts | Matches existing UX patterns |

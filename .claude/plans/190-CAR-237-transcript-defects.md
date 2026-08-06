# CAR-237 — Transcript defects: unreachable audio upload, unguarded RPC, VTT hour-format gap

Three independent defects in the transcript feature, all verified directly against code
(not inferred) while mapping the feature on 2026-08-06.

## 1. The in-app audio upload path has never worked

`careervine/src/components/conversation-modal/past-meeting-fields.tsx:58-100`
(`handleAudioFile`) has two breaks stacked on top of each other:

- **Line 69** POSTs to `/api/attachments/upload`, which does not exist. There is no
  `careervine/src/app/api/attachments` directory and no such route was ever added.
- **Line 83** sends `{ objectPath }` where `/api/transcripts/transcribe` requires
  `attachmentObjectPath` (`src/lib/api-schemas.ts:346`).

Effect: the Deepgram BYO-key transcription from CAR-30 is unreachable from the UI.
Selecting an audio file 404s before Deepgram is contacted. Nothing else in the codebase
calls `/api/transcripts/transcribe` and no test exercises it, which is why it survived.

**Fix.** Use the same client-side helper every other upload site uses — `uploadAttachment()`
from `src/lib/data/attachments.ts:20`, as at `src/app/meetings/page.tsx:277` and
`src/components/contacts/contact-attachments-tab.tsx:67`. `userId` is already a prop on this
component (line 19), so no plumbing is needed. Then send `attachmentObjectPath`.

**Guard against recurrence.** A test that drives `handleAudioFile` and asserts the outgoing
transcribe payload parses against the route's own Zod schema (`transcribeSchema`). Importing
the real schema rather than restating the key is what makes the test catch drift — a
hand-copied string literal would have passed happily through CAR-188's rename.

## 2. `replace_transcript_segments` is SECURITY DEFINER with no ownership check

`supabase/migrations/20260321100000_add_replace_transcript_segments_rpc.sql` grants EXECUTE
to `authenticated` on a `SECURITY DEFINER` function that never verifies `p_meeting_id`
belongs to the caller. Definer rights bypass RLS, so any signed-in user can delete and
replace another user's transcript segments.

The `transcribe` route checks ownership before calling, but that is not the trust boundary:
`createTranscriptSegments` (`src/lib/data/meetings.ts:286`) calls the RPC straight from the
browser, where the meeting id is fully attacker-controlled.

**Fix.** New migration redefining the function with an ownership guard against
`auth.uid()`, raising on mismatch. Keep the signature and grants identical so no caller
changes. Also add `WITH CHECK` to the `segments_update` RLS policy, which today has `USING`
only — an UPDATE can currently move a row to a meeting the user does not own.

**Verification.** Per rule 32, a dry-run does not execute SQL and proves nothing. Validate by
running the migration against production inside
`BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` before applying for real.

## 3. VTT parser rejects standard `HH:MM:SS.mmm` timestamps

`src/lib/transcript-parser.ts` `tryVtt` matches cues with
`/^(\d{2}:\d{2}[:.]\d{3})\s*-->/`. That accepts `MM:SS.mmm` but not `HH:MM:SS.mmm`.
Confirmed by running the regex directly: `00:00:05.000 --> 00:00:09.000` does not match.

`HH:MM:SS.mmm` is what Whisper, Zoom, and effectively every other tool emits, and what the
WebVTT spec requires past one hour. So "Upload text" silently fails on ordinary `.vtt` files.

**Fix.** Widen the cue regex to accept an optional hour group.
`parseVttTimestamp` already delegates to `parseTimestamp`, which handles both shapes, so
this is the regex alone — confirm that rather than assume it.

**Tests.** Both timestamp shapes, plus a cue past the one-hour mark, plus a file mixing the
two forms.

## Sequence

1. Migration + RLS policy fix, validated in a transaction against production, then applied
   (rule 27). Ordering matters: the guard is additive and safe to land before the code.
2. VTT regex + tests.
3. Upload wire + schema-pinned test.
4. `npm run test`, `npm run check:conventions`, `npm run test:integration`, `npm run build`.

## Out of scope

Local transcription itself is CAR-236. This ticket only makes the existing surfaces correct.

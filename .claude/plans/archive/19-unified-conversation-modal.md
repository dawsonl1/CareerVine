# Plan: Unified Conversation Modal

**Goal:** Replace all 8 interaction/meeting entry points with a single, unified modal based on the QuickCaptureModal design. Eliminate the `interactions` table over time and standardize on `meetings` as the single data model.

---

## Design Principles

- One modal, everywhere. Every "Log conversation" / "Add meeting" button opens the same modal.
- The modal is **context-aware** — fields appear/hide based on whether the date is in the past or future.
- Keep the QuickCaptureModal's clean, chip-based layout. Don't regress to dropdown-heavy forms.
- Progressive disclosure: start simple, reveal more as the user fills in fields.

---

## Modal Layout (top to bottom)

### Always Visible

1. **Who did you talk to?** — Multi-select contact picker (keep current behavior, including smart pre-fill)
2. **Meeting name** (optional) — Text input, placeholder "e.g. Coffee with Alex, Informational with Jane…"
3. **Type** — Chip selector (keep QuickCaptureModal's pill style). Unified type list:
   - Coffee Chat, Phone Call, Video Call, In Person, Lunch/Dinner, Conference, Networking Event, Other
   - No "Email" type — email logging happens automatically via Gmail integration
   - (Merges all 3 existing type lists, minus Email)
4. **When** — Date picker (keep current), **plus optional time picker** that appears inline next to date once a date is selected
5. **Duration** (optional) — Small dropdown/chip: 15m, 30m, 45m, 1h, 1.5h, 2h. Only show when Google Calendar toggle is on OR meeting is in the future.

### Past Meeting Fields (date is today or earlier)

6. **Notes** (optional) — Textarea, "What did you discuss?"
7. **Transcript** (optional) — Collapsible section. Paste text, paste from clipboard, or upload audio file. Uses existing `TranscriptUploader` component.
8. **AI Generate Action Items** button — Appears **grayed out/disabled** until notes or transcript has content. Calls existing `/api/transcripts/extract-actions` endpoint. Shows suggested items grouped by direction:
   - **Your commitments** (my_task) — things you said you'd do
   - **Waiting on {contact}** (waiting_on) — things they offered/committed to do for you
   - No "mutual" type — if something is a joint agreement (e.g. "let's schedule a follow-up"), the AI assigns it to `my_task` since the user is the one who needs to initiate
   - Each suggestion is editable before saving (title, due date, direction toggle)
9. **Follow-ups** — Manual add with direction support:
   - Title + due date (keep current inline inputs)
   - Direction toggle: my_task / waiting_on (defaults to my_task)
   - AI-suggested items appear in this same section, grouped by direction

### Future Meeting Fields (date is tomorrow or later)

6. **Private reminder notes** (optional) — Textarea, "Things to remember, topics to discuss, questions to ask…"
7. **Google Calendar section** (only if Gmail connected):
   - Toggle: "Add to Google Calendar" (default on)
   - Toggle: "Invite <Contact Name>" (default on) (if add to google calander if off, this should be set to off as well with no option to turn it on. If the user tried to turn it on a little message should appear telling them that they have to enable add to Google Calendar first.)
   - If on: Calendar invite description textarea, "Include Google Meet link" toggle, Duration selector
   - Contact email selection for invites (show warning if contact has no email)

### Footer (always)

- Cancel / Save button (same as current)

---

## Action Item Directions: Two Types Only

Plan 17 (action-item-ownership) originally proposed three direction types: `my_task`, `waiting_on`, and `mutual`. **We are simplifying to two types only: `my_task` and `waiting_on`.** The `mutual` type added complexity without enough payoff — joint agreements (e.g. "let's schedule a follow-up") are just `my_task` since the user is the one who needs to initiate.

**This decision supersedes plan 17 wherever they conflict.** When implementing, ensure the following everywhere in the codebase:

- **DB schema**: `CHECK (direction IN ('my_task', 'waiting_on'))` — no `mutual` value
- **TypeScript types**: `direction: 'my_task' | 'waiting_on'` — no `mutual` in union types
- **AI extraction prompt** (`extract-actions/route.ts`): Instruct the AI that there are only two directions. If something looks like a joint/mutual agreement, classify it as `my_task`.
- **Transcript suggestions UI** (`transcript-action-suggestions.tsx`): Only two groups — "Your commitments" and "Waiting on {contact}". No "Mutual" section.
- **Direction toggle in manual add**: Only two options — my_task / waiting_on
- **Action items page** (`action-items/page.tsx`): Filter into `my_task` items (normal due-date sections) and `waiting_on` items (separate "Waiting on others" section). No `mutual` section.
- **Contact profile actions tab** (`contact-actions-tab.tsx`): Two groups — "Your commitments" and "Waiting on {contact}". No "Mutual" group.
- **Home page dashboard** (`page.tsx`): Filter `waiting_on` out of pending follow-ups. No `mutual` filtering needed.
- **Suggestion generators** (`generate-suggestions.ts`): Nudge generator only looks for `waiting_on` items. No `mutual` handling.
- **Constants/enums**: Any `ActionDirection` or similar constants should only have two values.

---

## Data Model Changes

### Phase 1: Unified modal writes to `meetings` table
- All saves go to `meetings` + `meeting_contacts` (not `interactions`)
- This means QuickCapture-style saves that used to create lightweight `interactions` rows now create `meetings` rows instead
- The `meetings` table already has all the fields we need (title, notes, private_notes, transcript, calendar_description)

### Phase 2: Migrate existing `interactions` data (separate task)
- Write a migration script to move `interactions` rows into `meetings`
- Update the Activity page timeline to read only from `meetings`
- Update contact detail timeline to read only from `meetings`
- Drop `interactions` table

### Schema note
- The `meetings` table already supports everything. No schema changes needed for Phase 1.
- The type enum on `meetings` may need to be expanded to include the full unified type list (email, conference, networking_event, etc.)

---

## Entry Points to Modify

| Current | Change |
|---------|--------|
| Home page "Log conversation" button | Opens unified modal (no pre-fill) |
| Contact detail "Log conversation" | Opens unified modal (contact pre-filled) |
| Home page "Reach Out Today" cards | Opens unified modal (contact pre-filled) |
| Action Items page undo toast | Opens unified modal (contact pre-filled) |
| Activity page "Add meeting" | Opens unified modal (no pre-fill) |
| Contact detail Meetings tab "Add meeting" | Opens unified modal (contact pre-filled) |
| Activity page "Add interaction" | **REMOVE entirely** |
| Activity page empty state "Add interaction" | Replace with unified modal trigger |

---

## Components to Create/Modify

### New: `UnifiedConversationModal` (replaces `QuickCaptureModal`)
- Rename/evolve `quick-capture-modal.tsx` → keep same context provider (`useQuickCapture`)
- Add all new fields with conditional rendering based on date
- Integrate `TranscriptUploader` (already exists)
- Integrate Google Calendar toggle logic (extract from meetings page)
- Integrate AI action item generation button
- Save to `meetings` table instead of `interactions`

### Remove:
- `add-meeting-modal.tsx` — replaced by unified modal
- "Add interaction" form from `meetings/page.tsx` — removed entirely
- Inline "Add meeting" form from `meetings/page.tsx` — replaced by unified modal trigger

### Modify:
- `contact-quick-actions.tsx` — point to same context, no label change needed
- `contact-meetings-tab.tsx` — "Add meeting" button opens unified modal instead of `AddMeetingModal`
- `meetings/page.tsx` — "Add meeting" button opens unified modal; remove interaction form entirely
- Activity page timeline — eventually read from `meetings` only (Phase 2)

---

## Implementation Order

1. **Expand meeting type enum** — Add missing types to DB and constants
2. **Build unified modal** — Evolve QuickCaptureModal with all new fields, conditional rendering, save to `meetings`
3. **Wire up all entry points** — Replace all 8 triggers to open the unified modal
4. **Remove dead code** — Delete `AddMeetingModal`, inline interaction form, inline meeting form from activity page
5. **Test all flows** — Every entry point, past date, future date, with/without Gmail, with/without transcript
6. **Phase 2 (separate PR)** — Migrate `interactions` data, update reads, drop table

---

## Open Questions

- Should the unified modal open as a bottom sheet on mobile (current QuickCapture behavior) or as a centered modal? Current bottom sheet is good UX on mobile — keep it.
- "Social Media" as a type — worth keeping or is it too niche? Could fold into "Other".
- Editing an existing meeting from the Activity page should open in this same modal (confirmed). The modal needs an "edit mode" that pre-fills all fields from the existing meeting data.

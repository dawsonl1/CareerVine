# CAR-249 — Contact timeline: click any entry for full details, with edit and delete

## Problem

The contact detail page's Timeline tab merges four entry kinds into one list and renders each
as a compact row. Almost nothing recorded about an entry is reachable from there.

- **Meeting rows are inert.** `contact-timeline-tab.tsx:188-190` gives the row `cursor-pointer`
  and calls `onMeetingClick?.(m)`, but the contact page never passes that prop, so the row
  advertises a click that does nothing. Notes are `line-clamp-2`; attendees, action items,
  transcript and attachments are invisible. The app has exactly one `deleteMeeting` call site
  (`app/meetings/page.tsx:540`), so a meeting cannot be deleted from the contact page at all.
- **Interaction rows** hide edit and delete behind `opacity-0 group-hover:opacity-100`, and the
  summary is line-clamped with no way to read the rest.
- **Email and completed-action rows** have no affordance whatsoever.

## Shape

Every row opens a detail modal. Edit and delete are offered where they are meaningful. Edit
hands off to whatever already owns that record's form rather than growing a second one.

### The modal is owned by the PAGE, not the tab

This is the load-bearing decision. `ContactTimelineTab` renders inside a `SectionBoundary` whose
key is `${activeTab}:${dataGeneration}`, and every completed background refresh bumps
`dataGeneration` by design. A modal living in the tab is therefore unmounted mid-interaction
whenever a refresh lands. That is precisely the CAR-204 bug documented at
`contact-timeline-tab.tsx:45-54`, which is why `onConfirmDeleteInteraction` is already hoisted.

So the page owns `detailEntry` state and renders `<TimelineDetailModal>` next to
`<ContactEditModal>`, outside the boundary. The tab gets one new prop, `onEntryClick(entry)`,
and calls it from every row.

This also fixes an existing instance of the same bug: the interaction edit modal currently lives
*inside* the tab (`contact-timeline-tab.tsx:304-376`), so a background refresh silently discards
a half-typed edit. That form moves into the page-owned detail modal as its edit state.

### Per-kind behavior

| Kind | Detail shows | Actions |
| --- | --- | --- |
| `meeting` | title, date + time, type, attendee chips, notes, private reminders, action items, transcript, attachments | **Edit** → `useQuickCapture().openEdit(meeting, actions)`; **Delete** → `confirm` + `deleteMeeting` |
| `interaction` | type, date + time, full untruncated summary | **Edit** → inline form (moved from the tab); **Delete** → `confirm` + `deleteInteraction` |
| `email` | from / to / date, sanitized body, free-tier snippet fallback | **Reply** → `openCompose`. No edit or delete: these mirror Gmail |
| `completed_action` | title, description, completed + due dates, direction, linked meeting | **Reopen** → `updateActionItem`; **Delete** → `confirm` + `deleteActionItem` |

## Work

### 1. Data layer — `src/lib/data/meetings.ts`

`getMeetingsForContact` returns a lightweight projection with no `meeting_contacts`, and there is
no get-one read anywhere in the app. Add:

```ts
export async function getMeetingById(id: number): Promise<Meeting | null>
```

selecting `"*, meeting_contacts(*, contacts(*))"` to match `getMeetings`' row shape, through
`must()` (the read carries control flow: a null means "gone", and misreading a failed query as
absent would render an empty detail over a live meeting). `queries.ts` is a frozen barrel, so the
modal imports from `@/lib/data/meetings` directly.

The other three meeting reads already exist and are reused as-is: `getActionItemsForMeeting`,
`getAttachmentsForMeeting`, `getTranscriptSegments`.

### 2. Share the email body renderer

`contact-emails-tab.tsx:121-180` owns the live-body fetch (`/api/gmail/emails/{id}`), the
`canReadMailbox` free-tier fallback to the cached snippet, the mark-read side effect and the
`useLatestRequest` guard; `:462-478` owns the DOMPurify render. The timeline modal needs all of
it. Extract rather than copy:

- `src/hooks/use-email-body.ts` — the fetch, the free-tier fallback and the latest-request guard.
- `src/components/email/email-message-body.tsx` — the from/to/date header plus the sanitized
  body, with the `bodyText` `<pre>` fallback.

`contact-emails-tab.tsx` is rewritten onto both, so there is one implementation. The mark-read
side effect stays in the tab: reading a message from a timeline detail should mark it read too,
so it moves into the hook behind an explicit `markRead` option rather than being duplicated.

### 3. `src/components/contacts/timeline-detail-modal.tsx` (new)

Built on `Modal` from `components/ui/modal.tsx` per convention f. One component, a switch on
`entry.kind`, each branch a small local sub-render. Loads the meeting's four reads on open via
`Promise.allSettled`, so a failed transcript read does not blank the notes; each independently
failed section renders a `LoadErrorBanner` rather than reading as empty.

Escape, focus trap, dismissal-layer registration and the scroll lock all come from
`DialogSurface` beneath `Modal`. The interaction edit state reuses the existing
`hasUnsavedChanges` comparison so the discard guard still fires.

### 4. Page wiring — `app/contacts/[id]/page.tsx`

- `detailEntry` state, `<TimelineDetailModal>` rendered outside the `SectionBoundary`.
- Widen the local `CompletedAction` type with `description` and `direction`;
  `getCompletedActionItemsForContact` already selects `*`, so no query change.
- Mutations re-read through the existing `loadRelatedData()`, which already owns
  `relatedLoadFailed` and surfaces a failed re-read after a successful write.
- One new confirm callback per destructive kind, hoisted for the same reason as the existing one.

### 5. Delete copy tells the truth about action items

`follow_up_action_items.meeting_id` is `ON DELETE SET NULL`
(`20260214072106_add_meeting_id_to_action_items.sql:7`), so deleting a meeting **orphans its
action items rather than removing them**. The existing copy on `/meetings` says only "This action
cannot be undone." When the meeting has action items, the confirm says they will be kept and
unlinked. `/meetings` gets the same copy: one behavior, one sentence, both call sites.

## Testing

- `timeline-detail-modal.test.tsx` — one detail render per kind; meeting delete goes through
  confirm and calls `deleteMeeting`; a declined confirm deletes nothing; the meeting Edit button
  calls `openEdit` with the fetched meeting; a failed section read renders its banner and not the
  empty copy.
- `timeline-detail-modal-lifetime.test.tsx` — the regression that motivates the placement: the
  modal stays mounted with its state intact across a `dataGeneration` bump. Falsify it by moving
  the modal back inside the boundary and confirming it fails.
- `use-email-body.test.ts` — free-tier path never calls the gated route; premium path fetches;
  a superseded request does not overwrite a newer one.
- Existing `interaction-type-editor.test.tsx` is retargeted at the modal, since the form moves.
- `contact-detail-*.test.tsx` mocks of `ContactTimelineTab` need the new prop.

## Docs

- `public/docs/index.html` — the contact timeline description gains the click-for-detail
  behavior. Checked in the same PR per the docs-drift rule.
- `README.md` — product-level note that timeline entries open in full and can be edited or
  deleted from the contact page.
- Privacy policy unaffected: no new field, table, cache or processor.

## Out of scope

- No `/meetings/[id]` route. The `/meetings` feed already renders meetings fully expanded; a
  second detail surface there would be redundant.
- No change to how emails are stored or deleted. They mirror Gmail and stay read-only.

# CAR-260 — Contact timeline: stack same-thread emails, and exclude any entry from every calculation

## Problem

Three defects, all visible on one contact's Timeline tab.

1. **Thread flattening.** `contact-timeline-tab.tsx:83` maps `EmailMessage[]` one-to-one into
   entries, so a 6-message conversation is 6 rows. `buildThreads` (`src/lib/gmail-helpers.ts:34`)
   already exists and is used by the Emails tab (`contact-emails-tab.tsx:107`) and the inbox. The
   Timeline is the only surface that does not group.

2. **Nothing can be struck from the record.** Automated calendar mail (`Accepted: …`) is ingested
   as an ordinary inbound reply. `is_hidden` exists but is honored only by three *display* reads
   (`api/gmail/emails`, `api/gmail/inbox`, `api/gmail/unread`) and by **zero** derivation sites.

3. **Sent emails render twice.** `sendTrackedEmail` writes an `interactions` mirror row
   (`src/lib/email-send.ts:183`) with no link to the message it mirrors.

## Decisions (settled with Dawson before writing this)

- Exclusion covers all four timeline kinds, not just email.
- `is_excluded` is a **new** flag and a **strict superset** of `is_hidden`: setting it also sets
  `is_hidden`. Plain inbox-hide stays display-only, so nothing already hidden retroactively stops
  counting.
- `interactions.email_message_id` links the mirror row to its message.
- **No ingestion-time auto-detection.** Manual exclusion only.

### The one thing exclusion cannot fix, stated plainly

`syncEmailsForContact` runs three side effects the moment an inbound message lands
(`src/lib/gmail.ts:426-452`): `cancelFollowUpsForRepliedThreads`, `advanceCompaniesForContacts`,
and the `reply_received` event. Those are **one-time writes, not derived values**. Excluding the
message afterward corrects every recomputed surface (stage, traction, dossier, counts, last-touch)
but does not un-cancel the sequence or move the company back. Dawson chose this trade knowingly
over a detection heuristic. The confirm copy must not imply otherwise.

## Part 1 — Thread stacking

### Types (`src/lib/types.ts`)

`TimelineEntry` stays exactly as it is: it is the **detail modal's** input, and the modal opens on
a single message. The list gets its own union so the modal's switch keeps its exhaustiveness:

```ts
/** What the timeline LIST renders. Emails arrive grouped by thread (CAR-260). */
export type TimelineRowEntry =
  | { kind: "meeting"; date: string; data: ContactMeeting }
  | { kind: "interaction"; date: string; data: InteractionRow }
  | { kind: "email_thread"; date: string; data: EmailThread }
  | { kind: "completed_action"; date: string; data: CompletedActionEntry };
```

Clicking a stack header expands it. Clicking a message inside it calls
`onEntryClick({ kind: "email", … })`, so `TimelineDetailModal` is untouched. A one-message thread
renders as today's plain row and opens the modal directly, with no stack chrome.

### Placement and count

A stack sits at its `latestDate`, matching `buildThreads`' own sort and the Emails tab. The
`TIMELINE (n)` count becomes the number of **rows**, so the screenshot's `(9)` becomes `(4)`.

### Expanded state lives on the PAGE, not the tab

Same reasoning as CAR-249's modal placement, and the same bug if ignored: the tab renders inside a
`SectionBoundary` keyed on `${activeTab}:${dataGeneration}`, and every background refresh bumps
`dataGeneration`. State held in the tab is destroyed mid-read. The page owns
`expandedThreads: Set<string>` next to `detailEntry`.

### Folding the mirror interaction

Drop an interaction from the timeline **only when its `email_message_id` is present in the loaded
`emails` array**. Keyed on presence, not on the column being non-null, so a failed email load
(`emailsLoadFailed`) degrades to showing both rows rather than silently dropping history.

## Part 2 — Exclusion

### Migration

```sql
ALTER TABLE email_messages  ADD COLUMN is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE meetings        ADD COLUMN is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE interactions    ADD COLUMN is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE follow_up_action_items ADD COLUMN is_excluded boolean NOT NULL DEFAULT false;

ALTER TABLE interactions ADD COLUMN email_message_id integer
  REFERENCES email_messages(id) ON DELETE SET NULL;
```

Plus a backfill matching existing mirror rows on `(contact_id, interaction_type = 'email',
summary = 'Sent: ' || subject)` within the same day, and partial indexes where a filtered read is
on a hot path.

`NOT NULL DEFAULT false` throughout, copying `is_trashed`/`is_hidden` rather than the nullable
`is_simulated`.

### Two rules the flag lives or dies by

1. **Absent from both sync upsert payloads.** `email_messages` (`src/lib/gmail.ts:480`) and
   `calendar_events` (`api/calendar/sync/route.ts:242-297`) rely on ON CONFLICT touching only the
   keys present. A flag in the payload is cleared on every re-sync. This mirrors the existing
   `// Never overwrite is_read, is_trashed, or is_hidden` rule and is pinned the same way.
2. **`calendar_events.is_excluded` joins `CALENDAR_EVENTS_APP_OWNED`**
   (`src/__tests__/migration-destructive-guard.test.ts:58`), since a re-sync cannot restore it.

### Which reads filter, and which deliberately must not

The failure mode to avoid is `is_simulated`'s: correct at 6 sites, absent at 16, and nobody
noticed. Three categories, decided per site rather than blanket-applied:

| Category | Filters? | Examples |
| --- | --- | --- |
| Derivation and metrics | **Yes** | `getContactStages` email + calendar legs, `getDossierBundle`, `searchEmailHistory`, `getNetworkHealth`, `getHomeStats`, `getActivityHeatmap`, `checkCompaniesEmailedMilestone`, `buildLastTouchMap`, `company-stage-advance` |
| Sync bookkeeping | **No** | `knownMessageIds` and existence probes in `gmail.ts` — filtering makes the sync re-insert excluded rows on every run |
| Threading headers | **No** | `getCachedThreadMessages` feeding `resolveReplyHeaders`: a real outbound reply must thread onto the real last message |
| Display | Already covered | Contact Emails tab and inbox filter `is_hidden`, which exclusion sets |

### The guard that stops this decaying

A check in `scripts/check-conventions.mjs` enumerating every `.from()` call site on the five
tables and requiring each to either filter `is_excluded` or carry
`// exclusion-exempt: <reason>`. Without it this ends up exactly where `is_simulated` is. The
"must not filter" rows above become the initial exempt entries, each with its reason written out.

### API and UI

- `POST` / `DELETE` on a new `api/timeline/[kind]/[id]/exclude` route, following the existing
  `api/gmail/emails/[messageId]/hide` shape. Excluding an email also sets `is_hidden`; excluding a
  meeting also excludes its linked `calendar_events` row via `calendar_event_id`, or the stage
  engine still counts the call.
- **One action, one meaning.** The timeline detail modal's per-kind hard deletes are replaced by a
  single reversible **Remove**. `/meetings` keeps its own hard delete; that surface is out of scope.
- Undo lives on the timeline as a **Show removed** toggle rendering excluded entries
  de-emphasized with a Restore action. The inbox Hidden tab already covers emails; this covers the
  other three kinds, which have no such surface.
- Confirm copy states what actually happens: it stops counting toward suggestions and company
  progress, it stays in Gmail or Google Calendar, and it can be restored. No em dash (rule 35).

## Testing

- `gmail-helpers` already covers `buildThreads`; new coverage is for the timeline's use of it:
  stack count, single-message passthrough, placement at `latestDate`, mirror-interaction folding,
  and the `emailsLoadFailed` degrade path.
- Expanded state survives a `dataGeneration` bump, falsified by moving it into the tab (the
  CAR-249 lifetime test is the template).
- Per-kind exclusion round-trip: exclude, assert the derived surface changes, restore, assert it
  comes back.
- The `check-conventions` guard gets a test asserting it actually fires on an unfiltered read, per
  rule 52: probe it, print the diff, confirm the probe mutated what it claims to.
- **Integration tier** owns the one thing mocks cannot express: that a re-sync does not clear
  `is_excluded` on either table.

## Docs

- `public/docs/index.html` — the timeline feature card currently says "Meetings and interactions in
  one newest-first feed" (line 751), which is already wrong (it omits email) and gets both the
  thread grouping and the remove behavior.
- `README.md` — product-level note on both.
- `privacy/page.tsx` — new stored per-row user state. Additive and user-controlled, but it is a new
  persisted field, so the retention wording gets checked rather than assumed.

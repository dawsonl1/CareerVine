> **HISTORICAL - superseded, do not trust.** Written 2026-02-18 and not updated
> since. It was largely executed, then overtaken, so it reads plausibly while
> being wrong in load-bearing places. Do not use it to understand today's
> calendar behavior; read `careervine/src/lib/calendar.ts`, the routes under
> `careervine/src/app/api/calendar/`, and the migrations instead.
>
> Known divergences from shipped reality:
>
> - **Zoom integration (section 5) never shipped.** No `zoom_connections` table,
>   no Zoom OAuth, no API calls. The `zoom_link` column exists but is only ever
>   written as null.
> - **Recurring-event ingestion was repaired after shipping.** Section 19 assumed
>   Google returns recurring instances individually and never specified
>   `singleEvents: true`; the initial implementation consequently cached series
>   master rows next to their own instances, and
>   `20260717040000_car152_calendar_sync_repair.sql` flipped ingestion to
>   `singleEvents: true` and purged the master rows as phantom duplicates.
> - **Section 10's attendee auto-linking was a cross-tenant leak.** Matching ran
>   globally across `contact_emails`, so calendar rows could point at another
>   tenant's contact. Fixed under CAR-133; the CAR-152 migration nulls the bad
>   rows.
> - **The shipped schema is a superset** and the plan contradicts itself: its
>   section 2 schema block lacks the `calendar_event_contacts` junction that its
>   own section 21 later adds.
>
> Kept for provenance only (CAR-157).

# Google Calendar Integration Plan

## Overview

This document outlines the full implementation plan for Google Calendar integration in CareerVine. The integration reuses the existing Google OAuth infrastructure already in place for Gmail, extending it to include Calendar scopes. The goal is to give users a seamless scheduling experience tightly coupled to their contacts, meetings, and email workflow.

---

## 1. OAuth & Authentication

### How it works today (Gmail)
- User clicks "Connect Gmail" in Settings → redirected to Google consent screen
- Google redirects back to `/api/gmail/callback` with an auth code
- Code is exchanged for `access_token` + `refresh_token`, stored in `gmail_connections` table
- Every API route calls `getGmailClient(userId)` which auto-refreshes the token if expired

### What changes for Calendar
- Add Calendar scopes to the existing OAuth flow (same `gmail_connections` row — Google issues one token set per OAuth client):
  ```
  https://www.googleapis.com/auth/calendar
  https://www.googleapis.com/auth/calendar.events
  ```
- Because we need `prompt: "consent"` to re-issue a refresh token with the new scopes, users who already connected Gmail will need to **reconnect once** to grant Calendar access
- Add a `calendar_connected` boolean column to `gmail_connections` (or derive it from scope presence) so the UI can show a separate "Connect Calendar" state
- Create `src/lib/calendar.ts` mirroring `src/lib/gmail.ts` — `getCalendarClient(userId)` that reuses the same stored tokens

### DB change
```sql
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_scopes_granted boolean DEFAULT false;
```

---

## 2. Database Schema

### New table: `calendar_events` (local cache)
Caching events locally avoids hammering the Google API on every page load and enables fast filtering/search.

```sql
CREATE TABLE calendar_events (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  calendar_id     text NOT NULL DEFAULT 'primary',
  title           text,
  description     text,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  all_day         boolean DEFAULT false,
  location        text,
  meet_link       text,           -- Google Meet hangout link if present
  zoom_link       text,           -- Parsed Zoom link from description/location
  status          text,           -- confirmed | tentative | cancelled
  attendees       jsonb,          -- [{email, name, responseStatus}]
  contact_id      int REFERENCES contacts(id) ON DELETE SET NULL,  -- linked CareerVine contact
  meeting_id      int REFERENCES meetings(id) ON DELETE SET NULL,  -- linked CareerVine meeting
  synced_at       timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now(),
  UNIQUE(user_id, google_event_id)
);
```

### Extend `meetings` table
```sql
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_event_id text;  -- google event id
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meet_link text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_link text;
```

---

## 3. Feature Breakdown

---

### Feature A — Calendar Sync & Schedule View

**What it does:** Pulls the user's Google Calendar events for the next 14 days and shows them in a clean weekly/list view inside CareerVine.

**API routes:**
- `GET /api/calendar/sync` — fetches events from Google Calendar API for `now` to `now + 14 days`, upserts into `calendar_events` table
- `GET /api/calendar/events?start=...&end=...` — reads from local `calendar_events` cache, returns events for a date range

**UI:**
- New **Calendar** tab in the left sidebar (next to Inbox, Contacts, etc.)
- Two sub-views:
  - **Week view** — 7-column grid showing events as time blocks
  - **List view** — chronological list grouped by day, showing title, time, attendees, and meet/zoom link badges
- Auto-syncs on page load (debounced, max once per 5 min)
- Manual "Sync" button

**Implementation files:**
```
src/app/calendar/page.tsx
src/app/api/calendar/sync/route.ts
src/app/api/calendar/events/route.ts
src/lib/calendar.ts
supabase/migrations/YYYYMMDD_google_calendar.sql
```

---

### Feature B — Create Calendar Events (with Meet/Zoom)

**What it does:** When creating a new Meeting in CareerVine, optionally create a corresponding Google Calendar event with a Google Meet link auto-generated, or a Zoom link if the user has Zoom connected.

**Flow:**
1. User fills out the "New Meeting" form (contact, date, time, type, notes)
2. A toggle: **"Add to Google Calendar"** (default on if Calendar is connected)
3. A second toggle: **"Include video link"** → dropdown: `Google Meet` | `Zoom` | `None`
4. On save:
   - CareerVine creates the `meetings` row as normal
   - Calls `POST /api/calendar/events` to create the Google Calendar event
   - If "Google Meet" selected: Google Calendar API auto-generates a Meet link when `conferenceData.createRequest` is included in the event payload
   - If "Zoom" selected: Zoom API creates a meeting and returns a join URL (requires separate Zoom OAuth — see Section 5)
   - The Meet/Zoom link is stored back on the `meetings` row and shown in the meeting detail

**API route:**
```
POST /api/calendar/events
Body: { title, description, startAt, endAt, attendeeEmails[], conferenceType: "meet"|"zoom"|"none", meetingId }
```

**Google Calendar API call (Meet link):**
```typescript
calendar.events.insert({
  calendarId: "primary",
  conferenceDataVersion: 1,
  requestBody: {
    summary: title,
    start: { dateTime: startAt },
    end: { dateTime: endAt },
    attendees: attendeeEmails.map(email => ({ email })),
    conferenceData: {
      createRequest: { requestId: uuid(), conferenceSolutionKey: { type: "hangoutsMeet" } }
    }
  }
})
// Response includes: conferenceData.entryPoints[0].uri → the Meet link
```

**Sharing with attendees:** Google Calendar automatically sends invite emails to all `attendees` in the event payload. No extra work needed — the contact receives a calendar invite with the Meet link embedded.

---

### Feature C — "Insert My Availability" in Compose Modal

**What it does:** While writing an email, the user clicks an **"Insert availability"** button. A small panel opens where they configure:
- **Duration** — 30 min / 45 min / 1 hour / custom
- **Date range** — next N days (default 7)
- **Days of week** — checkboxes: Mon Tue Wed Thu Fri Sat Sun
- **Time window** — e.g. 9:00 AM – 6:00 PM

On clicking "Insert", CareerVine:
1. Fetches the user's calendar events for the specified date range from the local cache (or syncs first)
2. Computes free slots by finding gaps between busy blocks within the time window
3. Formats the result as plain text and inserts it at the cursor position in the email body

**Free/busy algorithm:**
```
For each selected day in range:
  1. Get all events that overlap with [windowStart, windowEnd] on that day
  2. Sort events by start time
  3. Walk the timeline: cursor = windowStart
     For each event:
       if cursor < event.start → free slot [cursor, event.start]
       cursor = max(cursor, event.end)
     if cursor < windowEnd → free slot [cursor, windowEnd]
  4. Filter slots shorter than requested duration
  5. Optionally merge adjacent slots
```

**Output format (inserted into email body):**
```
Monday (Feb. 9): 9:00 AM – 11:30 AM, 2:00 PM – 6:00 PM
Tuesday (Feb. 10): 9:00 AM – 12:00 PM
Thursday (Feb. 12): 1:00 PM – 6:00 PM
```
Days with no availability are omitted.

**API route:**
```
GET /api/calendar/availability?start=...&end=...&daysOfWeek=1,2,3,4,5&windowStart=09:00&windowEnd=18:00&duration=30
Returns: [{ date: "2026-02-09", label: "Monday (Feb. 9)", slots: ["9:00 AM – 11:30 AM", "2:00 PM – 6:00 PM"] }]
```

**UI in compose modal:**
- Small button **"Insert availability"** next to the "Write with AI" button in the toolbar
- Opens an inline panel (same pattern as AI write panel) with the config options
- "Insert" button calls the API and appends the formatted text into the RichTextEditor at the cursor

**Implementation files:**
```
src/components/availability-picker.tsx   — inline panel component
src/app/api/calendar/availability/route.ts
```

---

### Feature D — Auto-create Calendar Event When Logging a Meeting

**What it does:** When a user logs a past meeting in CareerVine (e.g. "I met with John on Feb 5th"), they get an option to retroactively add it to their Google Calendar. This keeps the calendar as a source of truth for all professional interactions.

This is a simpler version of Feature B — same API route, just without conference data, and the event is created in the past.

---

## 4. Implementation Order

| Phase | What | Effort |
|-------|------|--------|
| 1 | OAuth scope expansion + `calendar.ts` + DB migration | Small |
| 2 | Calendar sync API + events cache | Medium |
| 3 | Calendar page (list view) | Medium |
| 4 | Create event on new meeting (Meet link) | Medium |
| 5 | Availability picker in compose modal | Medium |
| 6 | Week grid view | Medium |
| 7 | Zoom integration (separate OAuth) | Large |

**Recommended start:** Phase 1 → 2 → 4 → 5. This gives the most user value fastest (scheduling + availability sharing) without needing the full calendar UI first.

---

## 5. Zoom Integration (Optional, Phase 7)

Zoom requires its own OAuth app:
- Scopes: `meeting:write:admin` or `meeting:write`
- Store Zoom `access_token` + `refresh_token` in a new `zoom_connections` table (same pattern as `gmail_connections`)
- `POST https://api.zoom.us/v2/users/me/meetings` → returns `join_url` and `start_url`
- The `join_url` is embedded in the calendar event description and stored on the `meetings` row

This is independent of Google Calendar and can be added later without changing the core architecture.

---

## 6. Settings UI for Calendar

The Settings page needs a **Google Calendar** card alongside the existing Gmail card. It should:

- Show connection status: "Connected as user@gmail.com" or "Not connected"
- Show `calendar_scopes_granted` state separately from Gmail — a user might have Gmail connected but not yet granted Calendar scopes
- If Gmail is connected but Calendar is not: show a **"Connect Google Calendar"** button that triggers a re-auth with the additional Calendar scopes (same `/api/gmail/auth` route, just with Calendar scopes added to the request)
- Show last synced time (`synced_at` from the most recent `calendar_events` row)
- Show a **"Disconnect Calendar"** button that sets `calendar_scopes_granted = false` on the `gmail_connections` row and deletes all rows from `calendar_events` for that user — it does NOT disconnect Gmail

**Important:** Since Gmail and Calendar share one OAuth token row, disconnecting Calendar does not revoke the token — it just clears the local cache and stops CareerVine from using Calendar APIs. The user would need to go to their Google Account permissions page to fully revoke Calendar access from the token. We should note this in the UI: "This removes Calendar access from CareerVine. To fully revoke, visit your Google Account."

**Implementation files:**
```
src/app/settings/page.tsx  — add Calendar card (same pattern as Gmail card)
src/app/api/calendar/disconnect/route.ts  — DELETE handler
```

---

## 7. Disconnect & Re-auth Flow

Since Gmail and Calendar share one `gmail_connections` row, the following rules apply:

| Action | Effect |
|--------|--------|
| Disconnect Gmail | Deletes the entire `gmail_connections` row → also loses Calendar access |
| Disconnect Calendar only | Sets `calendar_scopes_granted = false`, deletes `calendar_events` rows, keeps Gmail working |
| Connect Calendar (Gmail already connected) | Re-runs OAuth with all scopes (Gmail + Calendar), updates the existing row, sets `calendar_scopes_granted = true` |
| Connect Gmail fresh | Only Gmail scopes requested → `calendar_scopes_granted = false` until user explicitly connects Calendar |

**Re-auth flow for adding Calendar to existing Gmail connection:**
- `/api/gmail/auth` route accepts an optional `?scopes=calendar` query param
- When present, the auth URL is generated with Gmail + Calendar scopes combined
- The callback handler (`/api/gmail/callback`) checks which scopes were granted and updates `calendar_scopes_granted` accordingly
- The user sees a single Google consent screen that lists both Gmail and Calendar permissions

**Scope verification in callback:**
```typescript
// In /api/gmail/callback/route.ts
const grantedScopes = tokens.scope?.split(" ") || [];
const calendarGranted = grantedScopes.some(s => s.includes("calendar"));
await supabase.from("gmail_connections").update({
  calendar_scopes_granted: calendarGranted,
  // ... other token fields
}).eq("user_id", userId);
```

---

## 8. Event Updates & Deletes (Sync Lifecycle)

The initial plan only covered fetching events. The full sync lifecycle needs to handle:

### Incremental sync (updates & deletes)
Google Calendar API supports **sync tokens** — after the first full sync, subsequent calls return only changed/deleted events since the last sync. This is far more efficient than re-fetching everything.

```typescript
// First sync: no syncToken → full fetch, save nextSyncToken
const res = await calendar.events.list({ calendarId: "primary", timeMin, timeMax });
// res.data.nextSyncToken → store on gmail_connections row

// Subsequent syncs: pass syncToken → only get changes
const res = await calendar.events.list({ calendarId: "primary", syncToken: storedToken });
// Events with status: "cancelled" → delete from calendar_events
// Events with status: "confirmed"/"tentative" → upsert
```

**DB change:**
```sql
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_sync_token text;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_last_synced_at timestamptz;
```

### CareerVine-initiated updates
When a user edits a meeting in CareerVine that has a linked `calendar_event_id`:
- `PATCH /api/calendar/events/[googleEventId]` — updates title, time, description on Google Calendar
- If the meeting is deleted in CareerVine: prompt "Also delete from Google Calendar?" → `DELETE /api/calendar/events/[googleEventId]`

### Google-initiated deletes
During sync, any event returned with `status: "cancelled"` is deleted from `calendar_events`. If that event had a linked `meeting_id`, the `meetings` row is **not** automatically deleted — instead, the `calendar_event_id` column is cleared and the meeting detail shows "Calendar event was removed."

---

## 9. Attendee RSVP Status

The `attendees` JSONB column stores `responseStatus` per attendee (`accepted` | `declined` | `tentative` | `needsAction`). This should be surfaced in two places:

**In the Calendar page event detail:**
- Show each attendee with a colored status badge:
  - ✓ Accepted (green)
  - ✗ Declined (red)
  - ? Tentative (yellow)
  - — Awaiting (gray)

**In the Meeting detail in CareerVine:**
- If the meeting has a linked `calendar_event_id`, show the contact's RSVP status next to their name
- This is particularly useful for networking: "Did they accept my coffee chat invite?"
- The RSVP status updates automatically on each calendar sync

**No extra API calls needed** — `responseStatus` is already included in the `attendees` array returned by `calendar.events.list` and `calendar.events.get`.

---

## 10. Auto-linking Calendar Events to Contacts

During sync, each event's attendee emails should be matched against the `contact_emails` table to auto-populate `calendar_events.contact_id`. For events with multiple attendees (excluding the user themselves), link to the first matched contact.

**Matching logic in sync route:**
```typescript
for (const event of events) {
  const attendeeEmails = event.attendees
    ?.filter(a => a.email !== userGmailAddress)
    .map(a => a.email) || [];

  if (attendeeEmails.length > 0) {
    const { data } = await supabase
      .from("contact_emails")
      .select("contact_id")
      .in("email", attendeeEmails)
      .eq("contacts.user_id", userId)  // via join
      .limit(1)
      .single();

    contactId = data?.contact_id || null;
  }

  // upsert calendar_events with contactId
}
```

**Benefits:**
- Calendar page can show the contact's name and link to their profile
- Contact detail page can show upcoming/past calendar events with that person
- Availability picker can show "you have a meeting with [Contact]" in the busy blocks

---

## 11. Calendar Selection for Availability (Which Calendars Count as Busy)

The `freebusy.query` endpoint requires a list of calendar IDs. Users often have multiple calendars (personal, work, birthdays, holidays) and only some should count as "busy" for availability purposes.

**Flow:**
1. On first Calendar connect, fetch `calendar.calendarList.list` → store the list in a new `calendar_list` JSONB column on `gmail_connections`
2. In Settings (Calendar card), show a checklist: "Which calendars count as busy when sharing availability?"
   - Default: all calendars with `accessRole: "owner"` or `"writer"` checked; read-only calendars (holidays, birthdays) unchecked
3. Store the user's selection as a `busy_calendar_ids` text[] column on `gmail_connections`
4. The availability API uses `busy_calendar_ids` as the items list for `freebusy.query`

**DB change:**
```sql
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_list jsonb;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS busy_calendar_ids text[];
```

**`freebusy.query` call:**
```typescript
const res = await calendar.freebusy.query({
  requestBody: {
    timeMin: rangeStart,
    timeMax: rangeEnd,
    timeZone: userTimezone,
    items: busyCalendarIds.map(id => ({ id })),
  }
});
// res.data.calendars[calId].busy → array of { start, end } intervals
// Merge all busy intervals across all calendars, then compute free slots
```

---

## 12. Timezone Handling

**Authoritative timezone source:** Pull `calendar.settings.get({ setting: "timezone" })` on first Calendar connect and store it as `calendar_timezone text` on `gmail_connections`. This is the user's Google Calendar timezone, which may differ from their browser timezone (e.g. if they're traveling).

**DB change:**
```sql
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_timezone text DEFAULT 'America/New_York';
```

**Rules:**
- All `calendar_events` rows store `start_at` / `end_at` as UTC `timestamptz`
- The availability API receives the user's `calendar_timezone` from the DB and uses it for:
  - Converting the `windowStart` / `windowEnd` times (e.g. "9:00 AM") to UTC for the `freebusy.query`
  - Converting free slot UTC times back to the user's timezone for display
- The availability picker UI shows a small note: "Times shown in [timezone]" with a link to change it in Settings
- If the user's browser timezone differs from their Google Calendar timezone, show a warning: "Your browser timezone (PST) differs from your Google Calendar timezone (EST). Availability will use EST."

**Timezone conversion utility** (to add to `src/lib/calendar.ts`):
```typescript
import { formatInTimeZone, zonedTimeToUtc } from "date-fns-tz";
// date-fns-tz is already a common dependency; add if not present
```

---

## 13. Email Thread → Calendar Event Linkage

When a calendar event is created from within the compose modal (e.g. user is emailing a contact to schedule a meeting and then creates the event), link the `calendar_events` row back to the originating email thread.

**DB change:**
```sql
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_gmail_thread_id text;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_gmail_message_id text;
```

**Flow:**
- The compose modal has access to `replyThreadId` (already in context)
- When the user creates a calendar event from the compose modal (via a future "Schedule meeting" button in the toolbar), pass `threadId` and `messageId` to `POST /api/calendar/events`
- The route stores them on the `calendar_events` row

**Benefits:**
- In the email thread view, show a badge: "📅 Meeting scheduled" with a link to the calendar event
- In the calendar event detail, show "Scheduled via email: [subject]" with a link to the thread
- Gives a complete audit trail: email → calendar event → CareerVine meeting

---

## 6. Key Technical Notes

- **`googleapis` npm package** is already installed (used for Gmail). `google.calendar({ version: "v3", auth })` works with the same OAuth client — no new packages needed for Calendar.
- **Token reuse**: The same `getGmailClient()` pattern in `gmail.ts` can be copied to `calendar.ts` — same DB row, same refresh logic, just `google.calendar(...)` instead of `google.gmail(...)`.
- **Free/busy**: Use `calendar.freebusy.query` (not event list scanning) for the availability feature — it's a single API call that returns merged busy intervals across all selected calendars.
- **Timezone**: Store the user's Google Calendar timezone in `gmail_connections.calendar_timezone`. Use `date-fns-tz` for all timezone conversions. Show a warning if browser timezone differs.
- **Sync tokens**: Use Google's incremental sync token pattern to avoid re-fetching all events on every sync.
- **Rate limits**: Google Calendar API allows 1,000,000 queries/day per project — not a concern at this scale.

---

## 16. Dual Working Hours & Persistent Availability Defaults

Users can define two separate availability profiles in Settings — one for **normal contacts** and one for **high-priority contacts**. When opening the availability picker in the compose modal, CareerVine detects whether the recipient is a high-priority contact and pre-fills the appropriate profile. The user can override any field before inserting.

### Two availability profiles

| Profile | When used |
|---------|-----------|
| **Standard** | Default for all contacts |
| **Priority** | Auto-selected when the recipient's contact record has `is_priority = true` (or a "Priority" tag) |

### Settings UI — "Availability Defaults" card

Two side-by-side sub-cards (or a tab toggle "Standard / Priority") each with:

- **Working days** — checkboxes: Mon Tue Wed Thu Fri Sat Sun (default Mon–Fri)
- **Window start** — time picker (default 9:00 AM)
- **Window end** — time picker (default 6:00 PM)
- **Default duration** — 30 min / 45 min / 1 hour / custom
- **Buffer before** — 0 / 5 / 10 / 15 / 30 min (time to leave before a meeting)
- **Buffer after** — 0 / 5 / 10 / 15 / 30 min (time to leave after a meeting)

Priority profile example: tighter window (9am–5pm), longer buffer (15 min), weekdays only — because high-priority contacts get your most focused time.

### DB change

```sql
-- Stored as JSONB on gmail_connections for simplicity
-- Shape: { days: [1,2,3,4,5], windowStart: "09:00", windowEnd: "18:00", duration: 30, bufferBefore: 10, bufferAfter: 10 }
ALTER TABLE gmail_connections
  ADD COLUMN IF NOT EXISTS availability_standard jsonb,
  ADD COLUMN IF NOT EXISTS availability_priority jsonb;
```

### Availability picker override flow

1. User clicks "Insert availability" in compose modal
2. CareerVine checks if `to` email resolves to a contact with priority status
3. Loads the matching profile (`availability_priority` or `availability_standard`) from the DB
4. Pre-fills the picker panel with those values
5. User can change any field inline before clicking "Insert" — changes are **not** saved back to Settings (one-time override)
6. A small link at the bottom of the picker: "Save as default for [Standard / Priority]" — if clicked, updates the Settings profile

### Priority detection

```typescript
// In the availability picker component, after contact resolves:
const isPriority = contact?.tags?.includes("Priority") || contact?.is_priority === true;
const profile = isPriority ? user.availability_priority : user.availability_standard;
```

The existing contacts table already supports tags — no schema change needed for priority detection beyond ensuring a "Priority" tag convention is documented.

---

## 17. Buffer Time

Buffer time pads each busy block so the availability algorithm treats the time immediately before and after a meeting as unavailable. This prevents offering a slot that starts 5 minutes after a meeting ends.

### How it works in the algorithm

```
For each busy interval [busyStart, busyEnd]:
  effectiveBusyStart = busyStart - bufferBefore
  effectiveBusyEnd   = busyEnd   + bufferAfter

Free slots are computed against the expanded busy intervals.
```

### Settings vs. override

- **Default buffer** is set per profile in Settings (§16 above — `bufferBefore` and `bufferAfter` fields)
- **Override at generation time**: the availability picker panel shows "Buffer" as an editable field pre-filled from the profile, so the user can change it for that specific email without touching their defaults
- Buffer is applied symmetrically by default (same before and after) but the Settings card exposes both separately for fine-grained control

### Edge cases

- If two meetings are close together and their buffered intervals overlap, they are merged into one continuous busy block before computing free slots — no double-counting
- All-day events are treated as fully busy for the entire day (no buffer needed — the whole day is blocked)
- Buffer is capped at half the requested slot duration to prevent the algorithm from producing zero free slots when the calendar is sparse

---

## 18. Private & Confidential Events

Google Calendar events can have `visibility: "private"` or `visibility: "confidential"`. These must be handled carefully:

### During sync

```typescript
const isPrivate = event.visibility === "private" || event.visibility === "confidential";
await supabase.from("calendar_events").upsert({
  // ...
  title: isPrivate ? null : event.summary,
  description: isPrivate ? null : event.description,
  is_private: isPrivate,
});
```

### In the Calendar page UI

- Private events display as **"Busy"** with a lock icon — no title, no description, no attendees shown
- They still occupy their time slot visually (correct color, correct duration)
- Tooltip on hover: "Private event"

### In the availability algorithm

- Private events are treated as fully busy — their `start_at`/`end_at` are used normally for free/busy computation
- The fact that they're private is irrelevant to the algorithm; only the time block matters

### DB change

```sql
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT false;
```

---

## 19. Recurring Events

Google Calendar returns recurring event instances individually, each with a `recurring_event_id` field pointing to the parent series. Each instance is stored as a separate row in `calendar_events` — no special handling needed for the sync or free/busy logic. However, the UI should indicate recurrence.

### DB change

```sql
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurring_event_id text;
```

### UI treatment

- In the Calendar page list/grid view, show a small **↻ icon** next to the event title if `recurring_event_id` is not null
- In the event detail panel, show "Recurring event" as a label
- No need to show the full recurrence rule (RRULE) — just the indicator is enough

### Sync note

When a single instance of a recurring event is modified (e.g. the user moves just one occurrence), Google returns it as a normal event with its own `google_event_id` but with `recurringEventId` set. This is handled correctly by the upsert — it just becomes its own row with the modified time.

When an entire recurring series is deleted, Google returns all instances with `status: "cancelled"` during the next incremental sync — the sync route deletes all matching rows from `calendar_events`.

---

## 20. Empty Calendar / Not Yet Synced

The availability picker must handle the case where `calendar_events` has no rows for the requested date range (either Calendar not connected, not yet synced, or genuinely empty).

### Behavior

| State | What happens |
|-------|-------------|
| Calendar not connected | Picker shows a warning banner: "Connect Google Calendar in Settings to check real availability." The Insert button is still available and outputs the full time window as free. |
| Calendar connected but never synced | Same warning: "Your calendar hasn't synced yet." + a "Sync now" button that triggers `POST /api/calendar/sync` inline, then re-runs the availability query. |
| Calendar synced, genuinely no events | No warning. The full time window is returned as free. Output is the entire window for each selected day. |
| Sync in progress | Picker shows a loading spinner on the Insert button. |

### Implementation

The availability API route (`GET /api/calendar/availability`) checks `calendar_last_synced_at` on `gmail_connections`:

```typescript
if (!conn.calendar_scopes_granted) {
  return NextResponse.json({ notConnected: true, days: [] });
}
if (!conn.calendar_last_synced_at) {
  return NextResponse.json({ neverSynced: true, days: [] });
}
// Otherwise compute normally — zero events = full window free
```

The picker component reads these flags and shows the appropriate UI state.

---

## 21. Multi-Contact Event Linkage

§10 originally said "link to the first matched contact." This is lossy for group meetings. Instead, store all matched contacts via a junction table.

### DB change

```sql
-- Replace single contact_id on calendar_events with a junction table
-- Keep contact_id as a "primary contact" shortcut for single-attendee events
CREATE TABLE IF NOT EXISTS calendar_event_contacts (
  calendar_event_id  bigint NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  contact_id         int    NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (calendar_event_id, contact_id)
);
```

`calendar_events.contact_id` is kept as a denormalized "primary contact" field (the first matched contact) for fast single-contact lookups. `calendar_event_contacts` holds the full set.

### Matching logic (updated from §10)

```typescript
for (const event of events) {
  const attendeeEmails = event.attendees
    ?.filter(a => a.email !== userGmailAddress)
    .map(a => a.email) || [];

  const { data: matched } = await supabase
    .from("contact_emails")
    .select("contact_id")
    .in("email", attendeeEmails);

  const contactIds = [...new Set(matched?.map(r => r.contact_id) || [])];
  const primaryContactId = contactIds[0] || null;

  // Upsert calendar_events with primaryContactId
  // Then upsert calendar_event_contacts for all contactIds
}
```

### UI benefit

- A group lunch with 3 contacts shows all 3 names in the event detail with links to their profiles
- The contact detail page shows all events where that person was an attendee, not just events where they happened to be first

---

## 22. Sync Failure Safety

The `calendar_sync_token` must only be saved after a fully successful sync. Saving it mid-way through a failed sync would cause the next sync to miss events.

### Rules

1. **Never write `calendar_sync_token` until all events from the current sync batch have been successfully upserted**
2. If the sync throws at any point, catch the error, log it, and return without updating `calendar_sync_token` or `calendar_last_synced_at`
3. On the next sync attempt, the old token is still valid — Google keeps sync tokens alive for up to 7 days
4. If Google returns a `410 Gone` error for a sync token (token expired), clear `calendar_sync_token` and perform a full re-fetch

### Implementation pattern

```typescript
export async function syncCalendar(userId: string) {
  const conn = await getConnection(userId);
  const calendarClient = await getCalendarClient(userId);

  try {
    const events = await fetchAllEvents(calendarClient, conn.calendar_sync_token);
    // fetchAllEvents handles pagination internally, returns { events[], nextSyncToken }

    await upsertEvents(userId, events.events);  // all-or-nothing batch upsert

    // Only update token AFTER successful upsert
    await supabase.from("gmail_connections").update({
      calendar_sync_token: events.nextSyncToken,
      calendar_last_synced_at: new Date().toISOString(),
    }).eq("user_id", userId);

  } catch (err) {
    if (isGoneError(err)) {
      // Token expired — clear it and let next call do a full sync
      await supabase.from("gmail_connections")
        .update({ calendar_sync_token: null })
        .eq("user_id", userId);
    }
    throw err;  // Surface to caller so UI can show sync error
  }
}
```

---

## 23. Server-Side Sync Rate Limiting

Client-side debouncing (max once per 5 min) is not sufficient — multiple browser tabs or direct API calls could bypass it. The sync route enforces a server-side cooldown using `calendar_last_synced_at`.

### Implementation in `POST /api/calendar/sync`

```typescript
const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const lastSynced = conn.calendar_last_synced_at
  ? new Date(conn.calendar_last_synced_at).getTime()
  : 0;

if (Date.now() - lastSynced < SYNC_COOLDOWN_MS) {
  return NextResponse.json(
    { skipped: true, message: "Synced recently, try again later." },
    { status: 429 }
  );
}
```

The client treats a `429` response as a no-op (not an error) — it just means the data is already fresh. The UI does not show an error toast for 429s from the sync endpoint.

**Exception:** A manual "Sync now" button click bypasses the cooldown by passing `?force=true`. The route allows this but still enforces a hard minimum of 30 seconds between syncs to prevent accidental rapid-fire clicks.

---

## 24. "Scheduled" Badge on Sent Email Threads

When a calendar event is created and linked to an email thread via `source_gmail_thread_id` (§13), the inbox thread list should show a visual indicator.

### Implementation

- The `GET /api/gmail/inbox` route (or the thread-building logic) checks if any `calendar_events` row has `source_gmail_thread_id` matching each thread's `threadId`
- If yes, include a `hasCalendarEvent: true` flag on the thread object
- The thread row in the inbox renders a small **📅 calendar icon badge** next to the subject, similar to the existing follow-up clock badge
- Clicking the badge opens the calendar event detail (or scrolls to it in the Calendar page)

### DB query addition

```typescript
// In the inbox data-loading logic, after building threads:
const threadIds = threads.map(t => t.threadId);
const { data: linkedEvents } = await supabase
  .from("calendar_events")
  .select("source_gmail_thread_id, id, title, start_at")
  .in("source_gmail_thread_id", threadIds)
  .eq("user_id", userId);

const calendarByThread = Object.fromEntries(
  linkedEvents?.map(e => [e.source_gmail_thread_id, e]) || []
);
// Attach to thread objects before returning
```

---

## 14. Final DB Migration (Complete)

```sql
-- ── gmail_connections additions ──
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_scopes_granted   boolean   DEFAULT false;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_sync_token       text;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_last_synced_at   timestamptz;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_timezone         text      DEFAULT 'America/New_York';
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_list             jsonb;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS busy_calendar_ids         text[];
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS availability_standard     jsonb;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS availability_priority     jsonb;
-- availability shape: { days: int[], windowStart: "HH:MM", windowEnd: "HH:MM", duration: int, bufferBefore: int, bufferAfter: int }

-- ── calendar_events cache ──
CREATE TABLE IF NOT EXISTS calendar_events (
  id                      bigserial    PRIMARY KEY,
  user_id                 uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id         text         NOT NULL,
  calendar_id             text         NOT NULL DEFAULT 'primary',
  title                   text,
  description             text,
  start_at                timestamptz  NOT NULL,
  end_at                  timestamptz  NOT NULL,
  all_day                 boolean      DEFAULT false,
  location                text,
  meet_link               text,
  zoom_link               text,
  status                  text,                     -- confirmed | tentative | cancelled
  attendees               jsonb,                    -- [{email, name, responseStatus}]
  is_private              boolean      DEFAULT false,
  recurring_event_id      text,
  contact_id              int          REFERENCES contacts(id) ON DELETE SET NULL,
  meeting_id              int          REFERENCES meetings(id) ON DELETE SET NULL,
  source_gmail_thread_id  text,
  source_gmail_message_id text,
  synced_at               timestamptz  DEFAULT now(),
  created_at              timestamptz  DEFAULT now(),
  UNIQUE(user_id, google_event_id)
);

-- ── calendar_event_contacts junction ──
CREATE TABLE IF NOT EXISTS calendar_event_contacts (
  calendar_event_id  bigint  NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  contact_id         int     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (calendar_event_id, contact_id)
);

-- ── meetings table additions ──
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_event_id  text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meet_link          text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_link          text;

-- ── RLS ──
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own calendar events"
  ON calendar_events FOR ALL USING (auth.uid() = user_id);

ALTER TABLE calendar_event_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own calendar event contacts"
  ON calendar_event_contacts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM calendar_events ce
      WHERE ce.id = calendar_event_id AND ce.user_id = auth.uid()
    )
  );
```

---

## 15. Final Implementation Order

| Phase | What | Covers |
|-------|------|--------|
| 1 | OAuth scope expansion + `calendar.ts` + full DB migration | §1, §7, §14 |
| 2 | Settings UI — Calendar card, disconnect, dual availability profiles, buffer, calendar selection | §6, §7, §11, §16, §17 |
| 3 | Calendar sync API — incremental, multi-calendar, contact auto-link, private/recurring, rate limiting, failure safety | §8, §10, §18, §19, §21, §22, §23 |
| 4 | Calendar page — list view with RSVP badges, private event masking, recurring indicators | §3A, §9, §18, §19 |
| 5 | Create event on new meeting — Meet link, RSVP, thread linkage | §3B, §13 |
| 6 | Availability picker — freebusy, dual profiles, buffer, override, timezone, empty state | §3C, §11, §12, §16, §17, §20 |
| 7 | Sent email thread calendar badge | §24 |
| 8 | Calendar page — week grid view | §3A |
| 9 | Event edit/delete sync lifecycle | §8 |
| 10 | Zoom integration | §5 |

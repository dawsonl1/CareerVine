# Interaction Logging Audit

All user-facing entry points for logging interactions, meetings, or conversations.

---

| # | Page | Button Label | Modal/Form | Contact Selection | Type Options | Date/Time | Notes Field | Transcript | Action Items | Attachments | DB Table | Key Files |
|---|------|-------------|------------|-------------------|--------------|-----------|-------------|------------|--------------|-------------|----------|-----------|
| 1 | **Home page** toolbar | "Log conversation" | QuickCaptureModal | Multi-select from all contacts (none pre-filled) | 6 types: Coffee, Phone, Video, In Person, Event, Other | Date only (defaults to today) | Optional textarea ("Summary") | No | Yes — inline title + due date per item | No | `interactions` + `follow_up_action_items` | `src/components/quick-capture-modal.tsx`, `src/app/page.tsx:447` |
| 2 | **Contact detail** page (top-right quick actions) | "Log conversation" | QuickCaptureModal | Multi-select, but current contact is pre-filled | Same 6 types as #1 | Same as #1 | Same as #1 | No | Same as #1 | No | Same as #1 | `src/components/contacts/contact-quick-actions.tsx:24`, `src/components/quick-capture-modal.tsx` |
| 3 | **Home page** "Reach Out Today" cards | Click on contact card | QuickCaptureModal | Multi-select, clicked contact pre-filled | Same 6 types as #1 | Same as #1 | Same as #1 | No | Same as #1 | No | Same as #1 | `src/app/page.tsx:690`, `src/components/quick-capture-modal.tsx` |
| 4 | **Action Items page** (undo toast after completing an item) | "Log conversation" | QuickCaptureModal | Multi-select, action item's contact pre-filled | Same 6 types as #1 | Same as #1 | Same as #1 | No | Same as #1 | No | Same as #1 | `src/app/action-items/page.tsx:140`, `src/components/quick-capture-modal.tsx` |
| 5 | **Activity page** header toolbar | "Add meeting" | Full inline meeting form | Multi-select from all contacts (none pre-filled) | 3 types: Coffee Chat, Phone Call, Video Call | Date + optional time | Optional textarea ("Notes") | Yes — optional textarea for full transcript | Yes — title, description, assigned contacts, due date per item | Yes — file upload | `meetings` + `meeting_contacts` + `follow_up_action_items` | `src/app/meetings/page.tsx:520` (button), `:1352` (form) |
| 6 | **Contact detail** Meetings tab | "Add meeting" | Add Meeting Modal | Pre-filled with current contact (not changeable) | Same 3 types as #5 | Date + optional time | Optional textarea ("Notes") | No | No | No | `meetings` + `meeting_contacts` | `src/components/contacts/contact-meetings-tab.tsx:175`, `src/components/contacts/add-meeting-modal.tsx` |
| 7 | **Activity page** header toolbar | "Add interaction" | Inline interaction form | Single-select from all contacts | 8 types: Email, Phone Call, Video Call, Coffee Chat, Lunch/Dinner, Conference, Social Media, Other | Date only | Optional textarea ("Summary") | No | No | No | `interactions` | `src/app/meetings/page.tsx:525` (button), `:1353` (form) |
| 8 | **Activity page** empty state | "Add interaction" | Same inline interaction form as #7 | Same as #7 | Same 8 types as #7 | Same as #7 | Same as #7 | No | No | No | Same as #7 | `src/app/meetings/page.tsx:1010` |

---

## Inconsistencies & Observations

### Interaction type options are different everywhere
- **QuickCaptureModal (#1–4):** Coffee, Phone, Video, In Person, Event, Other (6 types)
- **Full meeting form (#5–6):** Coffee Chat, Phone Call, Video Call (3 types)
- **Standalone interaction form (#7–8):** Email, Phone Call, Video Call, Coffee Chat, Lunch/Dinner, Conference, Social Media, Other (8 types)
- No single form offers all types. Some types only exist in one form (e.g., "Email" and "Social Media" are only in #7–8; "In Person" and "Event" are only in #1–4).

### Contact selection is inconsistent
- QuickCaptureModal (#1–4): Multi-select — can log same conversation with multiple contacts at once
- Full meeting (#5): Multi-select — multiple attendees
- Contact meeting modal (#6): Locked to one contact
- Standalone interaction (#7–8): Single-select only

### Two completely separate data models for overlapping concepts
- `interactions` table: lightweight (contact_id, date, type, summary)
- `meetings` table: heavyweight (date, time, type, title, notes, private_notes, transcript, calendar_description, attachments)
- A "Coffee Chat" logged via QuickCapture goes into `interactions`; the same coffee chat logged via "Add meeting" goes into `meetings` — different tables, different schemas, different places in the UI

### Action item support varies
- QuickCaptureModal (#1–4): Can add follow-up action items inline (title + due date)
- Full meeting form (#5): Can add action items with title, description, assigned contacts, and due date
- Contact meeting modal (#6): No action item support
- Standalone interaction form (#7–8): No action item support

### Feature gaps per entry point
- Only #5 supports transcripts
- Only #5 supports file attachments
- Only #5 supports time (not just date)
- #6 is a stripped-down version of #5 (no transcript, no action items, no attachments)
- #7–8 are the simplest forms but have the most interaction type options

---

## Notes

<!-- Add your notes here -->


I like the way the QuickCaptureModal looks. I feel like this should be the way all of them look. I like that the "Who did you talk to?" is at the very top. I wish there were more types to log, to be able to log. I like when picking the date. But I wish there was an optional field after I select a date to fill in the time. Should not be mandatory. I like the notes, and I like that it's optional. If it was in the past, I wish a transcript spot would pop up. I wish there was the ability to have AI generate follow-ups and action items - this button should be maybe grayed out, but should be clickable once I add notes or a transcript and I should only see this button if the meeting has already happened. Currently, the Any Follow-Ups is visible even if it's in the future. I think it should only be visible if it's in the past. I like how sometimes it pre-fills the contact intelligently. I like how the activity add a meeting button lets me add a meeting name; however, I think that we should be able to do this from all of them. I don't like how the add meeting button doesn't let me select who the contact was with until I start filling it out. I like that there's private reminder notes if the meeting is in the future. It should be easier to incorporate that into the quick capture modal. Same with the add to Google Calendar and the include Google Meet link and the meeting duration. I think the ad interaction is useless. And we should get rid of that; it's just confusing. I would like the same pop-up to appear no matter where I click it integrating all of the things that I like and keeping it very organized. 

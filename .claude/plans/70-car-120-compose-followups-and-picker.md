# CAR-120 — Follow-ups + custom date/time picker in the compose popup

## Goal

In the draft-email popup opened from the contact page ("Compose email") and the
Outreach page ("Compose"):
1. Let the user attach a **follow-up sequence** (auto-cancels on reply).
2. Replace the native `<input type="datetime-local">` in the Schedule flow with the
   app's custom **DatePicker + TimePicker**.

## Decisions (Dawson, 2026-07-14)

- Follow-up creation = **AI-draft + manual edit/add**. AI drafts a plan from the
  composed email (reused intro pipeline); user can edit, remove, and **add steps by
  hand** (works with no AI key).
- **Known contacts only** for now. Non-contact recipients tracked in CAR-121.

## Design

### Part B — custom picker (self-contained, low risk)
`compose-email-modal.tsx`, Schedule row (~line 1000):
- Replace `scheduleDatetime: string` with `scheduleDate` (YYYY-MM-DD) + `scheduleTime`
  (HH:MM). Derive `scheduledAt = scheduleDate && scheduleTime ? new Date(`${date}T${time}`) : null`.
- Render `<DatePicker>` + `<TimePicker>` (from `ui/`) side by side.
- On opening Schedule, default to **tomorrow 09:05** so it starts populated.
- Update `handleScheduleSend` (use `scheduledAt`), the "Email scheduled" confirmation
  string, and the send-button `disabled` (`!scheduleDate || !scheduleTime`).

### Part A — follow-ups in regular compose
Reuse the machinery currently gated behind `isIntro`.

**Resolve a contact:**
- Thread `contactId` through the fresh-compose triggers: `contact-quick-actions.tsx`,
  `contact-info-header.tsx`, `contact-profile-card.tsx` (all have the `contact` obj).
  (Skip `contact-emails-tab.tsx` — those are replies.)
- In the modal: `matchedContactId` state, set from `contact.id` in `handleSelectContact`
  (autocomplete), cleared in `handleToChange` + reset. `activeContactId = contactId || matchedContactId`.

**UI (non-intro path):**
- `followUpsAvailable = !isReply && activeContactId > 0`.
- New `showFollowUps` state (default false). When available and hidden, render an
  **"Add follow-ups"** button (below the body, where intro's approve button sits).
- Clicking reveals the section. Empty state offers a **"Generate with AI"** button
  (calls the existing `generateFollowUps`, which already flips `introPhase` →
  loading → cards, and surfaces `AiUnavailableNotice` on no-AI) — so we don't spend
  an AI call unless asked.
- `FollowUpPlanSection`: add an optional `onAdd` prop → "+ Add follow-up" button for
  manual steps (new step defaults: subject `Re: <subject>`, empty body, delay = last
  step + 7 or 7). Passed in both intro and regular (purely additive).

**Wiring:**
- `generateFollowUps`: use `activeContactId`.
- `createFollowUpRecords`: gate `(isIntro || showFollowUps) && followUpsEnabled &&
  followUps.length && activeContactId`; payload `contactId: activeContactId`,
  `recipientEmail: to`, `contactName: selectedContactName || prefillName`.
- Section render: intro path unchanged; add `!isIntro && showFollowUps` branch.
- Reset all new state on open/close.

## Tests (rules 3, 4)
- Component test of `ComposeEmailModal` (mock `useCompose`, `fetch`): "Add follow-ups"
  shows when a `contactId` is present + hidden without one; adding a manual step then
  scheduling posts to `/api/email-follow-ups` with the contactId; the custom picker
  produces the expected ISO `scheduledSendAt`.
- `npm run test` + `npm run build` from `careervine/`.

## Docs (rule 34) / README (rule 7)
- Check `public/docs/index.html` "Write outreach" / "Follow up" sections and the
  README email bullet; this broadens follow-up creation to any contact compose —
  update copy only if the surface is described at that granularity.

## Out of scope
- Non-contact follow-ups (CAR-121). No schema changes. Paid inbox reply composes
  unchanged.

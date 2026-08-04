# Modal UX Improvements

**Findings addressed:** #7 (clicking off modal loses data), #10 (meeting modal dropdown overflow), #9 (log conversation can't add transcript)

---

## Problem Summary

1. **Quick Capture modal** (Log conversation): Clicking outside the modal instantly dismisses it, losing all typed content. No unsaved-changes warning. Also, there's no way to add a transcript from this modal.
2. **Email Compose modal**: Same backdrop-click dismissal issue, though it does silently auto-save drafts.
3. **Meeting creation modal** (Activity page): Date/time picker custom dropdowns extend outside the modal viewport, requiring awkward scrolling.

## Current Modal Architecture

**Base modal component** (`src/components/ui/modal.tsx`):
- Backdrop click → calls `onClose()` directly (no guard)
- Escape key → calls `onClose()` directly (no guard)
- No built-in unsaved-changes protection
- z-index: 50, max-height: 90vh, overflow-y: auto

**Quick Capture modal** (`src/components/quick-capture-modal.tsx`):
- Backdrop click at line 158: `onClick={close}` — immediate dismiss
- No content check before closing
- No transcript field
- Fields: contact picker, interaction type, date, notes, inline action items

**Email Compose modal** (`src/components/compose-email-modal.tsx`):
- Backdrop click at line 331: `onClick={handleClose}`
- `handleClose()` silently saves draft (2s debounce auto-save)
- Better than Quick Capture, but no explicit "you have unsaved changes" warning
- No visual "draft saved" feedback

**Meeting modal** (`src/app/meetings/page.tsx:566-939`):
- HAS unsaved-changes guard using native `confirm()` dialog (line 568)
- Date picker: 300px wide, `absolute z-50` positioning
- Time picker: 280px wide, `absolute z-50` positioning

## Proposed Solution

### 1. Add Unsaved-Changes Protection to All Modals

**Approach**: Add a shared `useUnsavedChanges` hook or enhance the base `Modal` component.

**Base Modal enhancement** (`src/components/ui/modal.tsx`):
```tsx
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  // New props:
  hasUnsavedChanges?: boolean;  // Parent controls this
  confirmMessage?: string;      // Custom message, default: "Discard unsaved changes?"
}
```

**Behavior when `hasUnsavedChanges` is true:**
- Backdrop click → show styled confirmation dialog (not native `confirm()`)
- Escape key → show styled confirmation dialog
- X button → show styled confirmation dialog
- Confirmation dialog: "You have unsaved changes. Discard?" with [Keep Editing] and [Discard] buttons
- Use app's M3 design system for the confirmation dialog (not browser native)

**Apply to each modal:**

| Modal | `hasUnsavedChanges` logic |
|-------|---------------------------|
| Quick Capture | `notes.length > 0 \|\| actionItems.length > 0 \|\| interactionType !== default` |
| Email Compose | `body.length > 0 \|\| subject.length > 0` (also keep draft auto-save) |
| Meeting | Replace native `confirm()` with styled dialog |
| Contact Edit | `any field changed from initial values` |
| Add Action Item | `title.length > 0` |

### 2. Add Transcript Support to Quick Capture Modal

The Quick Capture modal is the primary way to log conversations from a contact's profile. Users should be able to attach a transcript without having to go to the Activity page.

**Implementation:**
- Add an expandable "Attach transcript" section to the Quick Capture modal
- Reuse the existing `TranscriptUploader` component (`src/components/transcript-uploader.tsx`)
- When a transcript is attached:
  - Parse it client-side (existing `parseTranscript()` function)
  - Show a preview of parsed segments
  - On save: create the interaction AND a linked meeting with transcript segments
- Keep it collapsed by default so the modal stays clean for quick notes

**Flow:**
1. User opens Quick Capture → types notes as usual
2. Optionally clicks "Attach transcript" → expander reveals TranscriptUploader
3. User pastes/uploads transcript → parsed segments appear in preview
4. User clicks Save → creates interaction + meeting + transcript segments

**Consideration:** This blurs the line between "interaction" and "meeting." If a transcript is attached, the system should create a meeting record (since transcripts belong to meetings in the schema). The interaction and meeting would be linked.

### 3. Fix Meeting Modal Date/Time Picker Overflow

**Problem:** The date/time picker dropdowns render inside the modal's `overflow-y: auto` container, causing them to be clipped at the modal boundary.

**Root cause analysis:** The dropdowns use `absolute` positioning within the modal's scrollable content area. When the dropdown extends below the modal's visible area, it gets clipped by `overflow: auto`.

**Solutions (in order of preference):**

**Option A: Use React Portal for dropdowns**
- Render date/time picker dropdown via `createPortal(document.body)`
- Position absolutely relative to the trigger button using `getBoundingClientRect()`
- This ensures the dropdown renders above the modal's overflow container
- Requires updating `src/components/ui/date-picker.tsx` and `src/components/ui/time-picker.tsx`

**Option B: Use `overflow: visible` with CSS containment**
- Change the modal content area to `overflow: visible`
- Use CSS `contain: layout` on the modal to prevent layout leaks
- Riskier — could cause other overflow issues

**Option C: Flip dropdown direction when near bottom**
- Detect if the dropdown would overflow and flip it upward
- Simpler but doesn't solve all cases

**Recommended: Option A** — Portals are the standard React pattern for this. Both the date picker and time picker dropdowns should render via portal.

### 4. Add "Draft Saved" Feedback to Email Modal

Currently the email modal silently auto-saves drafts. Users don't know their work is protected.

**Add:**
- Brief "Draft saved" indicator (small text or icon) that appears for 2s after each auto-save
- Position it near the bottom of the modal, subtle but visible
- On close with unsaved changes: "Your draft has been saved. Close anyway?" with [Keep Editing] and [Close] buttons

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/ui/modal.tsx` | Add `hasUnsavedChanges` prop, styled confirmation dialog |
| `src/components/quick-capture-modal.tsx` | Wire up `hasUnsavedChanges`, add transcript section |
| `src/components/compose-email-modal.tsx` | Wire up `hasUnsavedChanges`, add "Draft saved" indicator |
| `src/app/meetings/page.tsx` | Replace native `confirm()` with styled dialog via modal prop |
| `src/components/ui/date-picker.tsx` | Render dropdown via React Portal |
| `src/components/ui/time-picker.tsx` | Render dropdown via React Portal |
| `src/components/contacts/contact-edit-modal.tsx` | Wire up `hasUnsavedChanges` |
| New: `src/components/ui/confirm-dialog.tsx` | Styled M3 confirmation dialog component |

## Design Principles

- **Never lose user work**: Any modal with editable content must warn before discarding
- **Consistent behavior**: All modals should use the same dismiss protection pattern
- **Styled, not native**: Replace all `confirm()` / `alert()` calls with styled M3 dialogs
- **Progressive disclosure**: Transcript attachment in Quick Capture should be collapsed by default

## Testing

- Verify backdrop click on Quick Capture with content → shows confirmation dialog
- Verify backdrop click on Quick Capture without content → closes immediately (no annoying dialog)
- Verify Escape key behavior matches backdrop click behavior
- Verify X button behavior matches backdrop click behavior
- Verify date/time picker dropdowns render above modal (not clipped)
- Verify transcript can be attached and parsed in Quick Capture
- Verify email draft save indicator appears
- Run `npm run test` for regressions

# Contact Profile Redesign Plan

## Problems with Current Design

1. **Flat, undifferentiated layout** — everything is a vertical list with no visual hierarchy
2. **Wasted horizontal space** — single narrow column, empty sides
3. **Details hidden behind toggle** — work history, education, tags all require expanding
4. **Bio/summary buried** — most contextual info is at the bottom
5. **Assigning follow-up cadence requires edit mode** — should be one click
6. **Adding/editing email requires edit mode** — should be inline
7. **Tab area dominates with empty state** — "No activity yet" wastes the page
8. **No clear action hierarchy** — what should I do next with this contact?

## Design Inspiration: Chrome Extension Patterns

The Chrome extension uses **inline editing with hover-to-reveal** — inputs look like display text until hovered/focused. Key patterns to bring to the web app:

- **Inline inputs**: transparent background, no border → hover shows subtle gray bg → focus shows primary ring
- **Follow-up cadence**: simple dropdown in a quick-info row with Clock icon, no modal needed
- **Email**: inline editable text field in the same quick-info row
- **No dialog hell**: simple fields editable in-place, full edit mode only for complex changes

## New Layout: Two-Column Card-Based Design

### Desktop (md+)

```
┌──────────────────────────────────────────────────────┐
│ ← All contacts                      [Log conversation]│
├──────────────────────────────────────────────────────┤
│ LEFT SIDEBAR (w-80, sticky)  │  MAIN CONTENT          │
│                              │                         │
│ ┌──────────────────────┐     │  ┌────────────────────┐ │
│ │ PROFILE CARD         │     │  │ QUICK ACTIONS BAR  │ │
│ │ Avatar (w-20 h-20)   │     │  │ [Email] [Log] [+]  │ │
│ │ Name + badge         │     │  └────────────────────┘ │
│ │ Title @ Company      │     │                         │
│ │ Location             │     │  ┌────────────────────┐ │
│ │ ─────────────────    │     │  │ PENDING ACTIONS    │ │
│ │ 📧 email (inline)    │     │  │ (if any)           │ │
│ │ 📞 phone             │     │  └────────────────────┘ │
│ │ 🔗 LinkedIn          │     │                         │
│ │ 🔄 Cadence (dropdown)│     │  ┌────────────────────┐ │
│ │ ─────────────────    │     │  │ TAB BAR            │ │
│ │ [Edit] [Delete]      │     │  │ Timeline │ Actions │ │
│ └──────────────────────┘     │  │ Emails │ Attach    │ │
│                              │  ├────────────────────┤ │
│ ┌──────────────────────┐     │  │                    │ │
│ │ ABOUT CARD           │     │  │ TAB CONTENT        │ │
│ │ Bio/summary text     │     │  │                    │ │
│ │ Met through          │     │  │                    │ │
│ │ Notes                │     │  │                    │ │
│ │ Tags (chips)         │     │  │                    │ │
│ └──────────────────────┘     │  │                    │ │
│                              │  │                    │ │
│ ┌──────────────────────┐     │  │                    │ │
│ │ EXPERIENCE CARD      │     │  └────────────────────┘ │
│ │ Work history         │     │                         │
│ │ Education            │     │                         │
│ └──────────────────────┘     │                         │
├──────────────────────────────────────────────────────┤
```

### Mobile (below md)
Single column: Profile card (horizontal layout) → Quick actions → Pending actions → Tabs

## Component Breakdown

### New Components to Create

#### 1. `contact-profile-card.tsx` — The hero sidebar card

Contains the most actionable info in one card:

**Top section:** Avatar, name, status badge, current title @ company, location

**Contact info section** (separated by border-t):
- Email — **inline editable** (click to type, auto-saves on blur)
- Phone — display with copy button
- LinkedIn — clickable link
- Follow-up cadence — **inline SimpleDropdown** (same pattern as Chrome extension)
  - Options: No follow-up, 2 weeks, 1 month, 2 months, 3 months, 6 months, 1 year
  - Click to change, saves immediately via API
  - Shows overdue indicator if past due

**Footer:** Edit (opens modal) and Delete buttons

**Inline editing pattern (from Chrome extension):**
```css
/* Input appears as text until interaction */
.inline-input {
  border: none;
  background: transparent;
  padding: 2px 4px;
  margin: -2px -4px;
  transition: background 0.15s, box-shadow 0.15s;
}
.inline-input:hover {
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
}
.inline-input:focus {
  background: #ffffff;
  box-shadow: 0 0 0 1.5px var(--primary);
  border-radius: 4px;
}
```

**Why email and cadence are in the profile card, not behind edit mode:**
These are the two most frequent actions on a contact — "what's their email?" and "how often should I follow up?" Making these require opening an edit form adds friction to the most common workflows.

#### 2. `contact-about-card.tsx` — Context & tags

- Bio/summary (if exists) — prominent text, not hidden
- Notes (private) — with inline edit capability
- Met through — subtle metadata
- Tags as M3 chips at bottom

#### 3. `contact-experience-card.tsx` — Career timeline

- Work history as mini-timeline (current role highlighted)
- Education below with graduation cap icon
- Compact but scannable

#### 4. `contact-quick-actions.tsx` — Top of main column

Horizontal row of tonal buttons:
- **Email** (opens compose, if Gmail connected)
- **Log conversation** (opens quick capture)
- **Add action** (opens action item creation)
- **Add meeting** (opens meeting form)

This replaces the current "Log conversation" button that sits alone in the top right.

### Components to Modify

#### 5. `contact-info-header.tsx` → Edit mode becomes a modal

- Strip out all view-mode rendering (moved to sidebar cards)
- Keep all edit form logic intact
- Wrap in Modal component (existing `modal.tsx`)
- Full form for complex edits: name, all emails, all phones, work history, education, tags, etc.
- `editing` state lifted to `page.tsx`

#### 6. `page.tsx` — Two-column layout

- Widen from `max-w-5xl` to `max-w-6xl`
- Flex row on desktop: sidebar (w-80, sticky) + main content (flex-1)
- Lift `editing` state to control edit modal
- Wire up quick actions to existing handlers

### Components Unchanged
- `contact-pending-actions-banner.tsx` — stays as-is, moves into main column
- `contact-timeline-tab.tsx` — no changes
- `contact-actions-tab.tsx` — no changes
- `contact-emails-tab.tsx` — no changes
- `contact-attachments-tab.tsx` — no changes
- `contact-avatar.tsx` — no changes (already supports size via className)

## Card Design System

Consistent pattern across all sidebar cards:

```tsx
// Card container
className="rounded-[16px] border border-outline-variant bg-surface-container-lowest p-5 space-y-3"

// Card section heading
className="text-xs font-medium text-muted-foreground uppercase tracking-wider"

// Icon + text row (contact info)
className="flex items-center gap-2.5 text-sm"

// Icon in row
className="h-4 w-4 text-muted-foreground shrink-0"
```

## Implementation Phases

### Phase 1: Sidebar Cards (view only)
1. Create `contact-profile-card.tsx` with static display (no inline editing yet)
2. Create `contact-about-card.tsx`
3. Create `contact-experience-card.tsx`
4. Render them in `page.tsx` but still single-column (validation step)

### Phase 2: Two-Column Layout
1. Update `page.tsx` to flex-row layout with sidebar + main
2. Move sidebar cards to left column
3. Keep tabs in right/main column
4. Add `contact-quick-actions.tsx` at top of main column
5. Mobile responsive: stack to single column below md

### Phase 3: Edit Modal
1. Lift `editing` state from `contact-info-header.tsx` to `page.tsx`
2. Wrap edit form in Modal component
3. Edit button in profile card triggers modal
4. Remove view mode code from `contact-info-header.tsx`

### Phase 4: Inline Editing (the Chrome extension magic)
1. Add inline email editing to profile card (type, blur to save)
2. Add inline follow-up cadence dropdown (click to change, auto-save)
3. Add inline notes editing in about card
4. Implement the hover-to-reveal CSS pattern from the extension

### Phase 5: Polish
1. Hover states and transitions on cards
2. Empty state improvements for tabs
3. Mobile layout refinements
4. Test all edit/save flows end-to-end

## Key Design Decisions

1. **Email and cadence in the profile card, not behind edit** — these are the two most common quick-actions, inspired by the Chrome extension's frictionless approach
2. **Two-column over single-column** — better use of horizontal space, sidebar stays visible while browsing timeline/emails
3. **Sticky sidebar** — contact info always visible as you scroll through activity
4. **Edit as modal, not inline toggle** — prevents the jarring view/edit switch for complex forms while keeping simple fields inline-editable
5. **Quick actions bar** — consolidates all "do something" buttons in one discoverable place

## Files Summary

### Create
- `src/components/contacts/contact-profile-card.tsx`
- `src/components/contacts/contact-about-card.tsx`
- `src/components/contacts/contact-experience-card.tsx`
- `src/components/contacts/contact-quick-actions.tsx`

### Modify
- `src/app/contacts/[id]/page.tsx` — two-column layout, lift edit state
- `src/components/contacts/contact-info-header.tsx` — strip view mode, wrap edit in modal

### Unchanged
- `src/components/contacts/contact-pending-actions-banner.tsx`
- `src/components/contacts/contact-timeline-tab.tsx`
- `src/components/contacts/contact-actions-tab.tsx`
- `src/components/contacts/contact-emails-tab.tsx`
- `src/components/contacts/contact-attachments-tab.tsx`
- `src/components/contacts/contact-avatar.tsx`

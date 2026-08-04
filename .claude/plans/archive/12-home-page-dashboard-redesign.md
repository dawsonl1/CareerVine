# Home Page Dashboard Redesign

**Findings addressed:** #3 (too many stacked sections), #4 (can't mark follow-ups done from home page)

---

## Problem Summary

1. The home page has four vertically stacked sections — Pending follow-ups, Reach out today, Suggested outreach, and Network health — creating a long scrolling page that feels cluttered and overwhelming.
2. Pending follow-ups can't be marked as done from the home page; users must click through to the profile page first.

## Current Layout

**All sections stacked vertically** (`src/app/page.tsx`):

1. **Greeting header** + "Log conversation" button
2. **Pending follow-ups** (lines 524-598) — Action item cards, clickable links to profiles. Up to 10 items.
3. **Reach out today** (lines 600-707) — Contacts with cadences that are due/overdue. Shows up to 6 cards with health rings + AI draft previews for top 3.
4. **Suggested outreach** (lines 709-766) — AI-generated suggestion cards with save/dismiss.
5. **Network health** (lines 768-828) — Health summary bar + avatar grid (up to 40 contacts).
6. **Quick-add contact** form

**Data overlap:**
- "Reach out today" and "Network health" both show contacts by health status — Reach out today is a filtered subset (only overdue contacts with cadences)
- "Pending follow-ups" shows action items (task-oriented), while "Reach out today" shows cadence-based contacts (relationship-oriented) — different data sets but overlapping intent

## Proposed Solution

### 1. Consolidate into a Two-Column Dashboard Layout

Replace the vertical stack with a responsive layout that groups related information:

**Left column (primary — action-oriented):**
- **"Your Actions"** — A unified section combining:
  - Pending action items (currently "Pending follow-ups")
  - Contacts due for outreach (currently "Reach out today")
  - AI suggestions (currently "Suggested outreach")
- Use a **tabbed or segmented control** within this section:
  - **Action Items** tab: pending tasks with inline "Mark done" buttons
  - **Reach Out** tab: contacts due for follow-up with inline quick-action buttons
  - **Suggestions** tab: AI-generated outreach ideas with save/done/dismiss
- Or use a **unified list** with a legend/icon system:
  - 📋 = Action item (task from a meeting)
  - 📞 = Cadence-based outreach (relationship maintenance)
  - ✨ = AI suggestion (proactive outreach idea)
  - Each item type has its own quick-actions inline

**Right column (secondary — overview):**
- **Network Health** — The avatar grid with health summary bar
- This is informational/at-a-glance, not action-oriented, so it belongs in a sidebar

**On mobile:** Stack left column above right column (already responsive).

### 2. Add Inline Quick Actions to Home Page Items

Every actionable item on the home page should be completable without leaving the page:

**Action Items (Pending follow-ups):**
- Add a **checkmark button** to mark as done directly from the card
- API call: `PATCH /api/action-items/[id]` with `is_completed: true`
- Animate removal from list on completion
- Show brief toast: "Action item completed"

**Reach Out Today contacts:**
- Add a **"Log interaction" button** that opens the Quick Capture modal pre-filled with that contact
- After logging, the contact's health resets and they drop off the list
- Add a **"Snooze" button** to push the follow-up date back (e.g., +7 days)

**Suggestions:**
- Already covered in the action-items-ux-overhaul plan (add mark as done + dismiss)

### 3. Simplify Network Health Display

- Keep the health summary bar (green/yellow/orange/red/gray counts) — it's compact and informative
- Make the avatar grid **clickable to filter** by health status (click a color in the legend to show only those contacts)
- Consider making the avatar grid **collapsible** (default collapsed on mobile, expanded on desktop)

---

## Layout Wireframe

```
┌─────────────────────────────────────────────────────────┐
│  Good morning, Dawson          [Log conversation]       │
├────────────────────────────┬────────────────────────────┤
│                            │                            │
│  YOUR ACTIONS              │  NETWORK HEALTH            │
│  ┌────────────────────┐    │  ┌────────────────────┐    │
│  │ [Tasks] [Reach Out]│    │  │ ■■■■ ■■ ■ ■■ ■■■  │    │
│  │ [Suggestions]      │    │  │ 12  4  2  3   8   │    │
│  └────────────────────┘    │  └────────────────────┘    │
│                            │                            │
│  ☑ Follow up with Sarah    │  (avatar) (avatar) (avtr)  │
│    Due today    [✓] [→]    │  (avatar) (avatar) (avtr)  │
│                            │  (avatar) (avatar) (avtr)  │
│  📞 Call Mike - 3d overdue │  ...                       │
│    Last: 2 weeks ago [📝]  │                            │
│                            │                            │
│  ✨ Reconnect with Lisa    │                            │
│    45d since contact       │                            │
│    [✓ Did it] [↓ Save] [✕] │                            │
│                            │                            │
└────────────────────────────┴────────────────────────────┘
```

## Alternative: Unified List with Filters

Instead of tabs, show all items in one priority-sorted list with filter chips:

```
YOUR ACTIONS    [All] [Tasks ☑] [Reach Out 📞] [Suggestions ✨]

1. ☑ Follow up with Sarah — due today          [✓ Done]
2. 📞 Call Mike — 3 days overdue               [📝 Log]
3. ✨ Reconnect with Lisa — 45d since contact  [✓] [↓] [✕]
4. ☑ Send proposal to Alex — due tomorrow      [✓ Done]
...
```

This approach is cleaner and avoids hiding items behind tabs. The filter chips let users focus when needed.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/app/page.tsx` | Major restructure: two-column layout, unified actions section, inline quick actions |
| `src/app/api/action-items/[id]/route.ts` | Ensure PATCH supports marking complete (may already exist) |
| `src/components/quick-capture-context.tsx` | Support pre-filling contact when opened from home page (may already work) |
| `src/app/globals.css` or Tailwind config | Grid layout utilities if needed |

## Design Considerations

- **Mobile-first**: On small screens, the two columns stack naturally. The unified list approach works better on mobile than tabs.
- **Performance**: Currently all four sections load independently. A unified list could use a single data fetch, improving load time.
- **Progressive disclosure**: Network health is secondary info — consider showing just the summary bar by default with an expand toggle for the avatar grid.
- **Quick Capture integration**: The "Log interaction" button for Reach Out contacts should use the existing Quick Capture modal (`src/components/quick-capture-modal.tsx`) which already supports pre-filling a contact.

## Testing

- Verify two-column layout renders correctly on desktop and mobile
- Verify inline "Mark done" on action items works and removes from list
- Verify "Log interaction" opens Quick Capture with correct contact pre-filled
- Verify filter chips correctly show/hide item types
- Verify Network Health grid is interactive and collapsible
- Run `npm run test` for regressions

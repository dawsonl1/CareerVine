# Action Items & Suggested Outreach UX Overhaul

**Findings addressed:** #1 (no "mark as done" on suggestions), #2 (clunky save flow on actions page)

---

## Problem Summary

1. **Suggested outreach items** on both the home page and actions page can be saved or dismissed, but there's no way to mark them as "done" — i.e., "I already reached out, no need to save this as a task."
2. **Actions page save flow** feels clunky: the AI-suggested box disappears abruptly after saving, the saved item appears as a task but can't be marked done inline, and refreshing the page regenerates new suggestions (since they're ephemeral with a 60s cache).

## Current Behavior

### Suggested Outreach (Home Page — `src/app/page.tsx:709-766`)
- Each suggestion card has two actions: **Save** (bookmark icon) and **Dismiss** (X icon)
- Save → creates an action item via `POST /api/suggestions/save`, shows toast
- Dismiss → removes from local state only (no persistence)
- No "I did this" / "Mark as done" action

### Suggested Outreach (Actions Page — `src/app/action-items/page.tsx:409-469`)
- Similar box at top of page titled "Suggested for you"
- Only has a **Save** button per suggestion (no dismiss)
- After saving: suggestion removed from list via optimistic state update, toast shown, action items list reloaded
- On page refresh: suggestions regenerate (ephemeral, cached 60s)
- Note at bottom: "These suggestions refresh each visit. Save the ones you want to keep."

### Suggestion Generation (`src/lib/ai-followup/generate-suggestions.ts`)
- Three rule-based generators + LLM batch generator
- Max 5 suggestions returned
- 60-second in-memory cache, invalidated on save
- Contacts with pending AI-suggestion action items are deduplicated

## Proposed Solution

### 1. Add "Mark as Done" to Suggestion Cards

Add a third action to suggestion cards: a checkmark button meaning "I already did this."

**Behavior:**
- Creates a **completed** action item (is_completed = true, completed_at = now) so we have a record
- Removes the suggestion from the UI (same as save)
- Prevents the contact from being re-suggested (same dedup logic as save, since a completed action item exists)
- Shows toast: "Marked as done" (no "View" link needed since it's already complete)

**Implementation:**
- Add new API route `POST /api/suggestions/complete` (or extend `/api/suggestions/save` with a `completed` flag)
- In `createActionItem()` (`src/lib/queries.ts:604-628`), support optional `is_completed` + `completed_at` fields
- Add checkmark button to suggestion cards in both `page.tsx` (home) and `action-items/page.tsx`
- Add `completeSuggestion()` to `useSuggestions` hook (`src/hooks/use-suggestions.ts`)

**UI for the three actions on each suggestion card:**
- ✓ (checkmark) — "I did this" → mark as done
- ↓ (bookmark) — "Save for later" → save as pending action item
- ✕ (X) — "Not interested" → dismiss (ephemeral, may resurface later)

### 2. Improve Actions Page Save/Complete Flow

**Problem:** After saving, the suggestion vanishes but the new action item appears in the list below — the transition feels disconnected and clunky.

**Improvements:**
- **Animate the transition**: When a suggestion is saved, animate it sliding/fading from the suggestions box into the action items list below (or at minimum, briefly highlight the newly-added action item with a pulse animation)
- **Add inline "Mark done" to action item cards** on the actions page: Currently users must click into an action item to mark it done. Add a visible checkmark button directly on each action item card (similar to how `contact-actions-tab.tsx:206-217` shows a hover-revealed checkmark)
- **Make the checkmark always visible**, not hover-revealed, since these are task-oriented items where completion is the primary action

### 3. Stabilize Suggestion Regeneration

**Problem:** Suggestions regenerate on every page load, which feels chaotic — you save one and a new one appears.

**Improvements:**
- **Increase cache TTL** from 60s to session-duration (or until all are acted upon)
- **Don't regenerate until all current suggestions are acted upon** (saved, completed, or dismissed)
- **Persist dismissed suggestions** for the session so they don't reappear on refresh (store dismissed IDs in sessionStorage or in the DB)
- Add a manual "Refresh suggestions" button for when the user wants new ones

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/use-suggestions.ts` | Add `completeSuggestion()`, persist dismissed IDs, session-stable caching |
| `src/app/api/suggestions/save/route.ts` | Accept optional `completed` flag to create already-completed action items |
| `src/lib/queries.ts` | Update `createActionItem()` to accept `is_completed`/`completed_at` |
| `src/app/page.tsx` (lines 709-766) | Add checkmark button to suggestion cards |
| `src/app/action-items/page.tsx` (lines 409-469) | Add checkmark + dismiss buttons to suggestion cards, add inline done button to action item cards |
| `src/app/action-items/page.tsx` (action item cards) | Add always-visible "Mark done" checkmark button |
| `src/lib/ai-followup/generate-suggestions.ts` | Increase cache TTL, support session-stable generation |

## Testing

- Verify "Mark as done" creates a completed action item in DB
- Verify completed suggestions don't resurface
- Verify dismissed suggestions don't reappear within same session
- Verify inline "Mark done" on action items works and updates UI immediately
- Verify suggestion cards on both home and actions pages have all three actions
- Run `npm run test` to ensure no regressions

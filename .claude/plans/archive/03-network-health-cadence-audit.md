# Network Health & Reach Out Today — Cadence-Aware Fixes

## Problem
Network Health colors use hardcoded absolute thresholds (14/30/60 days) that ignore per-contact `follow_up_frequency_days`. This misleads users — a 180-day-cadence contact touched 45 days ago shows orange ("at risk") when it's actually fine.

## Changes

### 1. Make `getHealthColor` cadence-aware
- Accept `follow_up_frequency_days` as a parameter
- Use ratio-based thresholds when cadence is set:
  - Green: ratio <= 0.5 (less than halfway through cycle)
  - Yellow: ratio <= 0.85 (approaching due date)
  - Orange: ratio <= 1.0 (due now)
  - Red: ratio > 1.0 (overdue)
- For never-contacted contacts with cadence: red
- For contacts with no cadence: "neutral" gray color

### 2. Add gray/neutral treatment for no-cadence contacts
- New color category: "gray" / "No cadence set"
- Distinct visual style (muted gray) so they don't create false urgency
- Sorted after red in the grid (bottom of the list)

### 3. Update legend labels
- Green: "On track"
- Yellow: "Due soon"
- Orange: "Due now"
- Red: "Overdue"
- Gray: "No cadence set"

### 4. Remove hardcoded 30-day stale threshold from Reach Out Today
- Only show contacts that have a cadence set and are overdue
- Don't surface no-cadence contacts as "stale" — the gray Network Health bubble is the nudge

### 5. Add "View all" link to Reach Out Today when > 6 items exist
- Link to /contacts filtered or sorted by overdue status

### 6. Update tests

## Files to modify
- `careervine/src/app/page.tsx` — getHealthColor, healthStyles, healthLabels, reachOutToday memo, Network Health rendering
- Tests for the above

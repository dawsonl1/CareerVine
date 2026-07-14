# CAR-122: Calendar UX fixes

## Problem

Five calendar bugs on Calendar page + Home daily schedule:

1. Overlapping events stack full-width instead of side-by-side
2. Editing a bare Google event creates a duplicate (POST create-event instead of PATCH)
3. Meeting type forced even with no contacts; make `meeting_type` nullable
4. No delete UI (backend DELETE already exists)
5. Home event popover double-offset (appears too low)

## Approach

1. Shared `calendar-layout.ts` column packing; wire into week view + TodaySchedule
2. Stash `editingGoogleEventId` on bare-event edit; PATCH path on save
3. Migration `ALTER TABLE meetings ALTER COLUMN meeting_type DROP NOT NULL`; optional Type select; null-safe displays
4. Red Trash2 + confirm; DELETE cascade Google + linked meeting
5. EventPopover `top: 0` relative to wrapper

## Out of scope

- Recurring series edit/delete UI
- Meetings Activity Log Google cascade beyond shared DELETE enhancement

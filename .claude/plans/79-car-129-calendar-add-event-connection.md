# CAR-129 — Calendar add-event silently skips Google create

## Problem

Adding an event on `/calendar` toasts success but never creates a Google Calendar event (nothing appears in week/list view beyond a CareerVine meeting row that may not show).

## Root cause

`checkCalendarConnection` calls `GET /api/calendar/availability` with no `start`/`end`. Schema validation returns 400, so `calendarConnected` stays false and `handleSaveMeeting` never POSTs `/api/calendar/create-event`.

## Fix

1. Replace local connection probe with `useGmailConnection().calendarConnected` (same as Home / Meetings).
2. Check create-event / PATCH responses and toast on failure instead of silently ignoring.
3. Regression test: document that the calendar page must not probe availability without date range for connection status (or cover the save-path gate via a small extracted helper if useful).

## Out of scope

Availability picker / slot computation (already passes start/end correctly).

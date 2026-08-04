# CAR-136 — MCP cancel_scheduled strands linked follow-up sequences

## Scope correction

The ticket originally listed three bugs. Bugs 1 and 2 (the `cancelled_user` CHECK violation on `scheduled_emails` and the rule-17 `.select()` read-backs in both MCP cancel helpers) were fixed by CAR-132 (PR #97, merged 2026-07-16) with tests in `mcp-cancel-cas.test.ts`. This ticket now covers only bug 3.

## Bug

MCP `cancelScheduledEmail` (`careervine/src/mcp/lib/db.ts`) cancels the `scheduled_emails` row but never touches follow-up sequences linked via `email_follow_ups.scheduled_email_id`. The web DELETE route (`/api/gmail/schedule/[id]`) cancels those sequences and their unresolved messages; the MCP path leaves them active, so a sequence whose opening email will never send keeps firing follow-ups into a thread that doesn't exist.

## Fix

1. Extract the linked-followup teardown from the web DELETE route into a shared helper `cancelFollowUpsForScheduledEmail(service, scheduledEmailId, now)` in `careervine/src/lib/follow-up-helpers.ts` (cancels unresolved `email_follow_up_messages` incl. expired per CAR-105, then flips the `email_follow_ups` parents to `cancelled_user`). Helper surfaces Supabase errors as throws instead of the route's current silent ignores.
2. Web DELETE route calls the helper (behavior unchanged, minus the silent-failure mode).
3. MCP `cancelScheduledEmail` calls the helper after its CAS succeeds.
4. Tests: extend `mcp-cancel-cas.test.ts` — MCP cancel with a linked active sequence cancels messages + parent; no linked sequence is a no-op; helper unit coverage for the CAR-105 expired-sibling inclusion.

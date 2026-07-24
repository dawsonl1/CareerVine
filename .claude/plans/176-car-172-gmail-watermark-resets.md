# CAR-172 — Gmail ingestion follow-ups: watermark resets + backfill gate

Three interaction bugs from the Straight A's program, all in the Gmail ingestion
path (`careervine/src/lib/gmail.ts`). One PR because they share files and state.

## 1. Disconnect destroys history (high)

`revokeAccess` deletes `email_messages` but leaves `contacts.email_synced_through`
stamped, so a reconnect resumes past the deleted span and never re-fetches it.

**Fix:** in `revokeAccess`, null `email_synced_through` (and the new
`email_backfilled_at`, see §3) for all the user's contacts — **before** the
cache deletes, and throwing on failure. Ordering is the safety argument: a
failed reset aborts the wipe (retryable, nothing lost); the reverse order could
strand deleted data behind a live watermark, which is exactly the bug.

## 2. New address on an existing contact never backfills (medium)

Five separate write paths insert into `contact_emails` (`addEmailToContact`,
bulk-import ×2, `bundle-fast-apply`, the admin contacts route), so an app-level
chokepoint can't cover them. The true chokepoint is the schema — same reasoning
as the CAR-153 `normalize_contact_email` trigger on this exact table.

**Fix:** migration `20260724000000_car172_email_sync_state_resets.sql`:
- `contacts.email_backfilled_at timestamptz` (new, for §3) + column comments.
- Trigger `contact_emails_reset_sync_state` — AFTER INSERT OR UPDATE OF email
  on `contact_emails`, nulls `email_synced_through` and `email_backfilled_at`
  on the parent contact (skipping no-op updates via an
  `OLD.email IS NOT DISTINCT FROM NEW.email` early return, and skipping rows
  already null). Invoker-rights (no SECURITY DEFINER): every writer that may
  insert a contact_email row may also update that contact under RLS.

Known accepted cost: the contact-edit flows delete-and-reinsert the address
set, so an edit spuriously resets the watermark → one idempotent ≤90-day
re-fetch for that contact on its next sync. Bounded, deduped, and far cheaper
than missing mail forever.

Nulling (vs. rolling back) is complete by construction: a null watermark makes
the next sync use the standard `sinceDays = 90` window, and cached rows are
never deleted, so nothing regresses.

## 3. Backfill full-scan on every page view (medium)

`backfillEmailsForContact` became an unconditional full-scan + junction rewrite
under `waitUntil` on `GET /api/gmail/emails` — live CPU per page view (CAR-106
territory).

**Fix:** staleness gate inside `backfillEmailsForContact` (chokepoint — both
callers and future ones get it):
- Skip when `contacts.email_backfilled_at` is younger than 24h. The route
  already reads the contact row for the IDOR check, so it prefetches the value
  and passes it via `opts.backfilledAt` (same pattern as `opts.syncedThrough`
  in `syncEmailsForContact`) — zero extra reads on the hot path.
- On completion, stamp `email_backfilled_at = start time`, completion-gated
  (any swallowed claim/junction error skips the stamp so the next view
  retries — mirrors the sync watermark contract), and CAS-guarded on the value
  read at the gate so a concurrent address-add's trigger reset can't be
  overwritten by a stale in-flight backfill (fire-and-forget, no readback).

The §2 trigger nulls `email_backfilled_at` on address adds, so a new address
backfills on the very next page view — the gate only suppresses *warm* repeats.
No tier gate: the claim pass is what attributes free users' sent-mail cache.

Backfill stays on the page-view path deliberately: free (send-only) users have
no sync path, so page-view backfill is their only attribution mechanism; the
gate removes ~all of its cost.

## Tests

- `gmail-revoke-access.test.ts`: extend — watermark reset happens, is
  user-scoped, and precedes the deletes; a failed reset aborts the wipe.
- `backfill-emails-cas.test.ts`: update builder for the gate read/stamp; new
  cases — skips when fresh, runs when stale/null, stamps on success, holds the
  stamp on junction failure, honors `opts.backfilledAt`.
- Migration: trigger covered by rolled-back apply against prod (rule 32) at
  apply time; consistency asserted by the destructive-migration guard suite
  passing (no destructive statements — purely additive).

## Deploy order (rule 42)

New code SELECTs `email_backfilled_at`, which this migration adds → apply the
migration to production **before** merging. Additive nullable column + trigger:
old deployed code never reads it, and the trigger's early watermark resets are
behavior old code already handles (null watermark = full-window sync).

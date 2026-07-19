# CAR-153 — Gmail ingestion correctness

**Retires audit findings R2.2 (watermark), R2.5 (alias direction), R2.8 (contact_emails normalization), R3.4 (throughput/waitUntil).**

Branch: `dawson/car-153-implementation-936b9d` (worktree `car-135-d475ca`, based on current `origin/main` @ ad52ce0, post-CAR-147 gmail.ts shape).

## Current defects (verified in code)

1. **Watermark** — `syncEmailsForContact` (gmail.ts:171-185) derives `afterEpoch` from `max(email_messages.date)` for the contact. Gmail lists newest-first, so an interrupted multi-page backfill caches the newest page, and the next sync starts *after* it: the older span becomes a permanent self-hiding hole.
2. **Alias direction** — direction is `fromAddr === gmailAddress.toLowerCase()` (gmail.ts:226). Mail sent from a Gmail send-as alias classifies as **inbound**, which falsely activates prospects (gmail.ts:283-289) and falsely fires `reply_received` (gmail.ts:297-317). The calendar attendee self-filter (calendar/sync/route.ts:141) has the same blind spot plus a case-sensitivity bug.
3. **Normalization** — `contact_emails.email` is stored as-written (mixed case). `activateContactByEmail` (gmail.ts:731) papers over it with unescaped `.ilike`; `detectBounces` (gmail.ts:981) uses `.eq` on a lowercased NDR address and silently misses mixed-case stored rows; calendar attendee matching (`.in`, route.ts:155) misses on case too.
4. **Throughput** — `syncAllContactEmails` (gmail.ts:391-436) is fully serial (one contact at a time); the emails route (route.ts:65-83) fires `backfillEmailsForContact`/`syncEmailsForContact` as bare floating promises that Vercel can freeze mid-flight after the response is sent.

## Changes

### 1. Migration `supabase/migrations/20260717020000_car153_gmail_ingestion_correctness.sql`

- `ALTER TABLE contacts ADD COLUMN email_synced_through timestamptz;` — per-contact completed-sync watermark (NULL = never fully synced → sinceDays fallback).
- `ALTER TABLE gmail_connections ADD COLUMN send_as_aliases jsonb;` — lowercased send-as alias array (NULL = unknown → primary address only).
- `contact_emails` normalization chokepoint:
  - One-time dedupe **before** lowercasing collides with the `(contact_id, email)` unique index: per `(contact_id, lower(trim(email)))` group, keeper = `is_primary DESC, id ASC`; keeper absorbs `bool_or(is_primary)` and earliest `bounced_at`; losers deleted (verified: nothing FKs `contact_emails.id`).
  - One-time `UPDATE ... SET email = lower(trim(email))` on remaining rows.
  - `BEFORE INSERT OR UPDATE OF email` trigger applying `lower(trim())`.
- Apply per rules 27 + 32: rehearse against production inside `BEGIN; SET LOCAL lock_timeout='3s'; ...; ROLLBACK;` before the real `supabase db push` (which happens only after merge).
- Regenerate `database.types.ts` via `npm run gen:types` (CAR-142 types-drift gate).

### 2. Fixtures — `careervine/src/__tests__/helpers/fake-gmail.ts` (new)

Configurable fake Gmail client: `messages.list` with multi-page `nextPageToken` sequencing and per-call failure injection; `messages.get` returning parameterized From/To/Subject/Date headers. Paired with an in-memory Supabase service-client fake covering the tables the sync touches (`contacts`, `gmail_connections`, `email_messages`, `contact_emails`). Drives the **real** `syncEmailsForContact` end-to-end. Baseline tests pin: direction classification, date parsing (invalid → null), safe-field-only updates on existing rows (never `is_read`/`is_trashed`/`is_hidden`).

### 3. R2.2 — completion-gated watermark

- `syncEmailsForContact`: derive `afterEpoch` from `contacts.email_synced_through` (minus the existing 1-day overlap buffer; re-fetches dedupe via the ignoreDuplicates upsert), falling back to `sinceDays` when NULL. Capture `syncStartedAt` before listing; write `email_synced_through = syncStartedAt` **only after** the do/while pagination loop finishes without throwing. The `max(cached date)` read is deleted.
- Accept an optional pre-fetched watermark (`opts.syncedThrough`) so `syncAllContactEmails` can batch the lookup (see §6); when absent, fetch it (emails route + `contact-email-history.ts` inherit with no signature churn there).
- `withRetry`: also retry Gmail **403 rate-limit** responses (`rateLimitExceeded` / `userRateLimitExceeded` reasons — the likeliest mid-backfill interruption), reading the reason from the googleapis error shape. Non-rate-limit 403s (e.g. missing scope) still throw immediately.

### 4. R2.5 — alias-aware direction

- `fetchSendAsAliases(gmail)` helper → `users.settings.sendAs.list` (covered by gmail.modify; free/send-only connections can't call it and stay primary-only), lowercased/trimmed.
- Callback route: when `modifyGranted`, fetch aliases best-effort during the token exchange and store on the upsert; failure stores nothing (NULL = primary-only, never blocks connect).
- Opportunistic refresh at the start of each `syncAllContactEmails` pass (best-effort, non-fatal), persisted to `gmail_connections.send_as_aliases`.
- `buildOwnAddressSet(gmailAddress, aliases)` pure helper in `gmail-helpers.ts`: Set of lowercased primary + aliases. `getConnection` select gains `send_as_aliases` (+ `modify_scope_granted` for the refresh gate).
- `syncEmailsForContact` classifies `direction` by membership in the set (4th param becomes the set/array; all 3 call sites updated). Activation + `reply_received` already gate on `direction === "inbound"`, so alias-sent mail now correctly does neither — pinned by test.
- Calendar attendee self-filter uses the same set with lowercased comparison.

### 5. R2.8 — normalized matching

- `activateContactByEmail`: `.ilike("email", email)` → `.eq("email", email.toLowerCase().trim())` (leaves zero ILIKE matchers on contact_emails — asserted by test).
- `detectBounces` becomes correct automatically (already lowercases the NDR address).
- Calendar sync: lowercase `attendeeEmails` before the `.in("email", ...)` match.

### 6. R3.4 — bounded concurrency + waitUntil

- `syncAllContactEmails`: contacts page query additionally selects `email_synced_through`; per-contact sync runs through a small worker pool (concurrency 4). Budget check gates *launching*; in-flight tasks are always awaited, and `nextCursor` = highest **contiguous** completed contact id (out-of-order completion can never skip a contact). `last_gmail_sync_at` still stamped only on full completion; failures still count and never wedge the cursor.
- `gmail/emails/route.ts`: wrap both fire-and-forget calls (`backfillEmailsForContact`, conditional `syncEmailsForContact`) in `waitUntil` from `@vercel/functions` (new dependency) so Vercel keeps the invocation alive after the response.

### 7. Tests (exit criteria)

- Watermark: fake Gmail throws on page 2 of 2 → `email_synced_through` unchanged, re-run re-covers the span (query `after:` unchanged); clean pass advances it. Legacy `max(date)` derivation gone.
- 403 with `rateLimitExceeded` retries then succeeds; 403 without a rate-limit reason throws immediately.
- Alias-From message → `direction=outbound`, no activation, no `reply_received`.
- `activateContactByEmail` issues `.eq` with the lowercased address; source-level assert that no `.ilike` remains on contact_emails.
- Pool: max in-flight ≤ 4 observed by the fake; out-of-order completion (slow first contact) still yields the contiguous cursor; budget yield + `last_gmail_sync_at` completion-only stamping preserved (existing gmail-sync tests updated for the new query/pool shape).
- Emails route: `waitUntil` receives both background promises (mocked `@vercel/functions`).
- Migration dedupe/lowercase/trigger rehearsed on production via BEGIN…ROLLBACK (rule 32) and recorded in the PR.

### Out of scope

Docs page (`public/docs/index.html`) describes sync behavior only at the "inbound and outbound emails" level — classification *fixes* don't change the documented contract, so no copy change (rule 34 checked).

## Order of work

1. Migration + types regen → 2. fake-gmail fixture + baseline tests (pin current correct behavior) → 3. watermark → 4. aliases/direction → 5. normalization call-site fixes → 6. pool + waitUntil → 7. full `npm run test` + `npm run build`, rule-32 rehearsal, PR with `(CAR-153)` title.

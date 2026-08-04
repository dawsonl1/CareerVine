# CAR-134 — Prevent duplicate scheduled-email sends (atomic claim step)

## Problem

`processScheduledEmails` (careervine/src/lib/gmail.ts:875) reads all due `pending` rows, sends via Gmail, and only after the round trip marks the row `sent`. Two independent drivers run it concurrently for the same user:

1. QStash cron every 15 min (`/api/cron/send-scheduled-emails` → `scheduled-email-cron.ts`)
2. Fire-and-forget POST to `/api/gmail/schedule/process` on every contact-detail page load

Both can read the same pending row and double-send a real email; the race window is the full Gmail send. Separately, a lambda kill between the Gmail send and the mark-sent write leaves the row `pending` and it re-sends next tick.

## Design

**Claim state, not retry-on-crash.** A stale claim cannot distinguish "crashed before send" from "crashed after send, before mark-sent", so auto-retrying a stale claim reproduces the double-send. Stale claims are therefore *flagged* (`failed`) and surfaced to the user with a one-click Retry, never silently re-sent.

### 1. Migration `supabase/migrations/20260716200000_car134_scheduled_email_claim.sql`

- Widen the CHECK to `('pending','sending','sent','cancelled','failed')`.
- `ADD COLUMN claimed_at TIMESTAMPTZ`.
- Partial index on `claimed_at WHERE status = 'sending'` for the sweeper.
- Validate with the rule-32 rolled-back apply against production (dry-run alone proves nothing).
- Regenerate/patch `database.types.ts` (`claimed_at`).

### 2. Atomic claim in `processScheduledEmails` (gmail.ts)

Per row, before sending (rule-17 `count:'exact'` CAS, mirroring `follow-ups/confirm/route.ts:96`):

- Claim: `update({status:'sending', claimed_at, updated_at}, {count:'exact'}).eq('id', id).eq('status','pending')`. `count !== 1` → another driver has it → skip (counts neither sent nor error).
- Send via `sendTrackedEmail` (unchanged policy handling: 429 → revert to `pending` + stop batch; 422 bounce → revert + continue).
- Generic send error → revert to `pending` (clear `claimed_at`), count error — parity with today's retry-next-tick.
- Success → mark `sent` guarded with `.eq('status','sending')` so a racing cancel can't be overwritten.
- Add optional injected deps (`service`, `send`) for tests, same pattern as `scheduled-email-cron.ts`.

### 3. Staleness sweeper (scheduled-email-cron.ts)

At the top of `processDueScheduledEmails`: rows with `status='sending'` and `claimed_at` older than 15 min (no lambda outlives that; cron cadence is 15 min) → `status='failed'`. Report `sweptFailed` in the cron result/telemetry.

### 4. Guard the sibling write paths (same race family)

- DELETE `/api/gmail/schedule/[id]`: CAS-cancel first (`.in('status', ['pending','failed'])`, count) → 409 if already sending/sent; only then cancel linked follow-ups (today it cancels follow-ups before checking, and cancels regardless of status).
- PUT `/api/gmail/schedule/[id]`: make the pending-only guard part of the UPDATE itself (CAS + count) instead of read-then-write.
- Constants: add `Sending`/`Failed` to `ScheduledEmailStatus`.

### 5. Surface `failed` rows (they must not vanish silently)

- `/api/gmail/inbox` + `/api/gmail/schedule` GET: include `failed` alongside `pending` (never `sending`, which is transient).
- New POST `/api/gmail/schedule/[id]/retry`: CAS `failed → pending` with `scheduled_send_at = now`; client follows with the existing fire-and-forget process call so it sends immediately.
- inbox-shell + outreach-shell Scheduled tabs and contact-emails-tab: status-aware badge ("Didn't send" destructive style for failed) + Retry action; existing Cancel keeps working for failed rows. Copy without em dashes (rule 35).
- Docs page "Scheduled sends" card: one sentence on the failed/retry behavior (rule 34).

### 6. Tests (Vitest, `careervine/`)

- New `scheduled-email-process.test.ts`: concurrent drivers → exactly one send (CAS-aware mock); claim miss skips cleanly; 429/422/generic error revert paths; success marks sent with the sending guard.
- `scheduled-email-cron.test.ts`: stale `sending` rows swept to `failed` and not re-sent; fresh claims untouched.
- Retry route CAS behavior if route-test infra permits.

## Out of scope (noted for follow-ups)

- CAR-132 (follow-ups CAS fix, F1) is not in flight; this sweeper design can be mirrored there.
- MCP `cancelScheduledEmail` has its own pre-existing bugs (invalid `cancelled_user` status + rule-17 read-back) — spawned as a separate task.
- Emailing the user when a scheduled send fails (badge + retry covers the loop for now).

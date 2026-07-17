# CAR-139 — Harden the send/sync engine: fail-loud reads, complete claim lifecycles, and live tier-filter hot patches

Wave 1 · T2 of the Straight A's program (CAR-28). Retires findings F6, F50, F27. Finishes the judge's Immediate tier after CAR-132/134 fixed the scheduled_emails double-send.

## 1. Stale-'sending' recovery for email_follow_up_messages

The last claim table without a stale-claim lifecycle: a crash between the `pending → sending` claim and the `sent`/revert write strands the row in `sending` forever, and the completeness count at `send-follow-ups/route.ts:288` (which counts `sending` as open) pins the parent sequence open permanently.

**Migration** `supabase/migrations/20260717000000_car139_followup_claim_lifecycle.sql` (mirrors `20260716200000_car134_scheduled_email_claim.sql`):
- `ALTER TABLE email_follow_up_messages ADD COLUMN claimed_at TIMESTAMPTZ;`
- Partial index `idx_follow_up_messages_sending ON email_follow_up_messages (claimed_at) WHERE status = 'sending'` for the sweeper scan.
- Backfill `claimed_at = now()` for any row already stuck in `'sending'` (pre-feature strands have no timestamp; this hands them to the first sweep ~15 min after deploy).
- No CHECK change needed — `'sending'` is already in the CHECK since `20260712065000_car105_followup_nudge_expiry_columns.sql`.

**Claim stamping**: both claim sites (`send-follow-ups/route.ts:231-235`, `confirm/route.ts:96-100`) stamp `claimed_at` alongside the `sending` flip. Every revert-out-of-`sending` write clears it (`claimed_at: null`); the `sent` write leaves it (harmless — the sweeper filters on `status='sending'`).

**Sweep** (cron preamble in `send-follow-ups` `runJob`, before the due query): rows with `status='sending'` and `claimed_at` older than the staleness window flip to **`awaiting_review`** with the full CAR-105 parking stamp (`parked_at=now`, `expires_at=now+14d`, `reminder_count=0`, `last_reminder_at=null`, `seen_during_window=false`), count-based.

Why `awaiting_review` (the "user-resolvable state, never auto-resend" per CAR-134 semantics): the send may or may not have gone out, so nothing may auto-retry (`pending` is out). `awaiting_review` plugs into every existing recovery surface with zero new UI — the Outreach portal and contact-page "Send now / They replied" buttons (ACTIONABLE statuses), the daily nudge-digest emails (which query by status only, so the user is emailed regardless of tier), and the confirm route's claim guard. It counts as UNRESOLVED, so the parent sequence stays open until the user resolves it, and once they do the normal completeness count closes the sequence — un-pinning it.

**Constant**: rename `SCHEDULED_SEND_STALE_CLAIM_MINUTES` → `SEND_STALE_CLAIM_MINUTES` (it now governs both send paths; same "no lambda runs this long" rationale). Two prod call sites + tests.

## 2. Last rule-17 CAS shapes (gmail.ts)

`backfillEmailsForContact` (`gmail.ts:505-521`): both orphan-match updates use `.update({matched_contact_id}).is('matched_contact_id', null).select('id')` — the update writes the column the filter tests. Convert to `{ count: "exact" }` and sum counts.

## 3. Delete the four fire-and-forget page-load triggers

Remove `fetch("/api/gmail/schedule/process", …)` from:
- `app/contacts/[id]/page.tsx:166`
- `components/email/inbox/inbox-shell.tsx:516`
- `components/email/outreach/outreach-shell.tsx:204`
- `components/contacts/contact-emails-tab.tsx:88`

The 15-min cron is the sole send driver (judge's explicit order). The route itself stays (exit criteria allow route+cron). Update the now-stale comment at `gmail.ts:903` that cites "the contact-page fire-and-forget process call" as the race partner.

## 4. F50 — FollowUpMessageStatus.Sending

Add `Sending: "sending"` to `FollowUpMessageStatus` in `constants.ts` with a transient-claim doc comment cross-referencing the CHECK migration (`20260712065000_car105_followup_nudge_expiry_columns.sql`). Replace the four raw literals (`confirm/route.ts:98,159`, `send-follow-ups/route.ts:233,288`) and use it in the new sweep. Also swap the `scheduled_emails` `"sending"` literals (`scheduled-email-cron.ts:56`, `gmail.ts:912,926,975`) for the existing `ScheduledEmailStatus.Sending` while in there — same F50 class.

## 5. F6 — fail-loud reads

Silently-swallowed `{data: null, error}` reads become throws:
- `bundle-sync.ts` apply-phase prospect read (:403), pre-apply fingerprint contact read (:448), removal-phase read (:591), linkage read (:603) — a throw aborts the step before the `synced_version` commit at :661, routing recovery to the daily stale-scan instead of silently skipping a delta.
- `bulk-import.ts` suppression-tombstone read (:287-295) — an error now fails the chunk instead of silently re-importing tombstoned contacts.
- `send-follow-ups` due query (:46-60) and `scheduled-email-cron.ts` due read (:59-65) — throw; both run inside `withCronGuard`, so the cron emits the `api_error` guardrail event and returns 500 instead of a false-healthy `{processed: 0}`.

## 6. Hot patches (live prod bugs)

- **Tier filter divergence**: add `.eq("network_status", "active")` to `getRelationshipsOnTrack` (`queries.ts:2137-2140`) and `getContactsWithLastTouch` (:1382-1387), matching `getHomeCoreData` (:1972). Prospects/bench contacts were deflating the on-track % and polluting the health grid. (Structural fix lands with the rules-extraction ticket.)
- **F27 duplicate locations**: in `api/contacts/import/route.ts`, route the contact-level location objects (`updateExistingContact` ~:195-203 and `createNewContact` ~:286-296) through `normalizeParsedLocation` (already imported) before `findOrCreateLocation`, matching the experience-row path — so 'CA' and 'California' resolve to one canonical locations row.

## Tests

- Sweep: stale `sending` row (old `claimed_at`) → `awaiting_review` with the full parking stamp; fresh claim untouched; sequence completes after the user resolves the swept row.
- Claim lifecycle: claims stamp `claimed_at`; reverts clear it (both routes).
- Fail-loud: each of the six reads erroring → throw; bundle-sync leaves `synced_version` unadvanced; both crons produce a 500/failure signal, never a success payload.
- CAS: `backfillEmailsForContact` counts claims without `.select()` read-back.
- Locations: 'CA' and 'California' profile locations resolve to one `locations` row via the import route.
- Tier filter: both queries filter on `network_status = 'active'`.
- Repo greps (exit criteria): zero `.update(...).select()` on a filter-tested column; zero `/api/gmail/schedule/process` refs outside route+cron; zero `"sending"` DB-status literals outside constants.ts.

## Landing

`npm run test` + `npm run build` green → PR `(CAR-139)` → on Dawson's merge go-ahead: migration per rule 27 (dry-run, rule-32 BEGIN/ROLLBACK rehearsal against prod, `supabase db push`). Docs page checked for drift (rule 34) — the page describes follow-up/scheduled-email behavior at user level; verify whether page-load-triggered sending is mentioned.

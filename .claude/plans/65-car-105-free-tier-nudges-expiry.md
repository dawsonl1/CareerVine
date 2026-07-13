# Plan 65 — CAR-105: Free-tier follow-up nudges + active-aware expiry

Phase 2-of-the-free-tier polish, on top of the shipped CAR-102 Outreach tier. Free-tier follow-ups already park as `awaiting_review` and persist until the user acts. CAR-105 adds: reminder **emails** (nudges), an **"expires in X days"** countdown, and an **active-aware expiry** that softly retires stale items without ever destroying them.

> **Design locked with Dawson (2026-07-12):** the **active-aware** expiry model (not the simpler fixed model), because keeping an engaged user's item *unexpired* keeps it in the main Outreach follow-ups list where they'll see it, instead of dropping it to a greyed row on a contact page they may never open. And **expired ≠ deleted**: an expired follow-up stays visible on the contact's account, greyed + labeled "Expired," and remains **one-click sendable**.

---

## The model (precise semantics)

Per parked follow-up message, let `P` = the moment it became `awaiting_review`.

- **Countdown:** the portal shows "Expires in N days" derived from `expires_at` (initially `P + 14d`).
- **Emails (3 per item):** an **initial notification the day it is parked** (day 0, in that day's digest), then **reminders at P+4d and P+9d**. No emails after `P+14d`. (This supersedes the ticket's "up to 2 nudges": day 0 is the heads-up that a follow-up is ready to review, day 4 + day 9 are the reminders.)
- **Expiry (active-aware):**
  - If the user was **active in-app during `[P, P+14d]`** → the item expires at `P+14d`.
  - If the user was **not active during the window** → do **not** expire behind their back. Wait for their next visit after `P+14d`; expire **24h after** that return. If they never return, it never expires (stays `awaiting_review`, still in the portal).
- **On expiry:** the message flips to a new `expired` status. It is **not** cancelled or deleted. The parent sequence stays `active` so the message remains sendable.

### Expiry state machine (what the nudge cron enforces per message)

New per-message fields: `parked_at`, `expires_at`, `seen_during_window bool`, `reminder_count int`, `last_reminder_at`.

Each daily cron run, for every `awaiting_review` message (joined to its user + follow-up):
1. **Track engagement:** if `now <= P+14d` and `user.web_last_seen_at >= P`, set `seen_during_window = true`.
2. **Expire:**
   - `seen_during_window` true → when `now >= P+14d`, flip to `expired`.
   - `seen_during_window` false and `now >= P+14d`:
     - if `user.web_last_seen_at > P+14d` (they've returned): set `expires_at = web_last_seen_at + 24h` (once), flip to `expired` when `now >= expires_at`.
     - else (still away): leave it `awaiting_review`, keep waiting.
3. **Email (day 0 / 4 / 9):** while `awaiting_review`, `now < P+14d`, user opted in — send the next unsent milestone that is due: day 0 at `reminder_count==0`, day 4 (`P+4d`) at `reminder_count==1`, day 9 (`P+9d`) at `reminder_count==2` (stop at 3). Collect every due message, **group by user, send ONE digest email per user** (day-0 items read "ready for review," day-4/9 "still waiting"), then bump `reminder_count` + `last_reminder_at` on each included message.

---

## What the grounding revealed (3 net-new subsystems)

A read-only code sweep of post-CAR-102 `main` found the ticket quietly assumes infrastructure that does not exist yet:

1. **No app→user email path at all.** Every email today is the user's Gmail (`sendTrackedEmail`) or Supabase's auth SMTP. A nudge is *CareerVine emailing the user* — the first of its kind. Resend is ready (`careervine.app` verified there), but the client, sender identity, and templates are net-new.
2. **No "active in the web app" signal.** Only `extension_last_seen_at` (extension-only), stamped in `api-handler.ts:150-162`; the cookie/web branch stamps nothing, and there is no middleware. The active-aware rule needs a real web last-active timestamp.
3. **No parking timestamp, no opt-out.** The CAR-102 park write records only `status: awaiting_review` with no time (`send-follow-ups/route.ts:117-127`), so there is no anchor for the countdown/expiry/nudges. And there is zero email opt-out / unsubscribe / `List-Unsubscribe` infrastructure anywhere.

Copyable positives: the cron pattern (`withCronGuard` + QStash `Receiver`) is clean, and the Outreach portal already isolates the `awaiting_review` items, so the countdown has an obvious home.

---

## Schema (migrations, root `supabase/migrations/`)

1. **`email_follow_up_messages`** — add `parked_at timestamptz`, `expires_at timestamptz`, `reminder_count int NOT NULL DEFAULT 0`, `last_reminder_at timestamptz`, `seen_during_window boolean NOT NULL DEFAULT false`. Add `expired` to the **named** status CHECK via drop/re-add (the established pattern: `20260325000000_intro_email_flow.sql:13`, `20260712040000_car102_awaiting_review_status.sql:9-13`).
   - **Backfill** existing `awaiting_review` rows: `parked_at = COALESCE(scheduled_send_at, created_at)`, `expires_at = parked_at + interval '14 days'` (near-moot today — CAR-102 just shipped — but correct).
2. **`users`** — add `web_last_seen_at timestamptz` and `followup_nudges_enabled boolean NOT NULL DEFAULT true`. Confirm CAR-27 column-lock posture: both are service-role-written (cron / api-handler) and app-read; grant read as needed, keep writes service-role.
3. Hand-edit `database.types.ts` Row + Insert (mirror the CAR-102/CAR-103 pattern; add new columns to the Insert `Omit<…>` where defaulted).

**Also update the CAR-102 park write** (`send-follow-ups/route.ts` free branch) to stamp `parked_at = now`, `expires_at = now + 14d`, `reminder_count = 0`, `seen_during_window = false` when it flips a message to `awaiting_review`.

---

## App→user email primitive (first one)

- `src/lib/notify/email.ts` — `sendAppEmail({ to, subject, html, listUnsubscribeUrl })` via Resend REST (`POST https://api.resend.com/emails`, Bearer `RESEND_API_KEY`, `fetch` — no new dep). Sender: **`CareerVine <notifications@careervine.app>`** (proposed). Always sets the `List-Unsubscribe` + `List-Unsubscribe-Post` headers.
- **Nudge template:** a clean, single-column HTML email — greeting, "You have N follow-ups waiting for your review," a short list (contact + subject), one CTA button to the Outreach portal, and an unsubscribe footer. Rule 5 (clean, purposeful), rule 35 (no em dashes).
- **Env:** add `RESEND_API_KEY` to Vercel (`vercel env add`, rule 28) + a signing secret `NUDGE_UNSUBSCRIBE_SECRET`. Redeploy after.

## Opt-out / unsubscribe (CAN-SPAM-safe)

- `users.followup_nudges_enabled` (default true) gates all nudge sends.
- Settings toggle in the notifications area ("Email me reminders about follow-ups awaiting review").
- `GET /api/notifications/unsubscribe?token=<hmac>` — unauthenticated one-click; the token HMACs `{userId, purpose:"followup_nudges"}` with `NUDGE_UNSUBSCRIBE_SECRET`; sets the flag false; renders a small confirmation page. Wired into the email's `List-Unsubscribe` header + footer link.
- Keep it a single boolean for now (YAGNI); generalize to a prefs table only when a second notification type appears.

## Web last-active tracking

- Stamp `users.web_last_seen_at` in `api-handler.ts`'s cookie/web auth branch (`:163-177`), **throttled** — only write when null or older than ~1h — fire-and-forget, never blocking or faulting the request (mirror the extension `:150-162` stamp).

## The nudge cron

- `POST /api/cron/follow-up-nudges` — QStash-signed (`Receiver`), `withCronGuard("/api/cron/follow-up-nudges", runJob)`, `maxDuration` 60. **Daily** cadence (day-granular).
- `runJob`: fetch `awaiting_review` messages + parents + each user's `web_last_seen_at` / `followup_nudges_enabled`; run the expiry state machine (mark `seen_during_window`, flip due items to `expired`, apply the grace branch); collect due nudges, group by user, send one digest each, bump counters. Fire `follow_up_expired` / `nudge_sent` into `analytics_events` (lightweight).
- **Schedule:** I create the QStash daily schedule via the QStash API myself (region-pinned endpoint, `$QSTASH_TOKEN`) — not a Dawson manual step.

## Confirm-route extension (keep expired sendable)

- `POST /api/gmail/follow-ups/confirm` currently accepts only `awaiting_review` (my CAR-102 n6 guard). Extend to accept `status IN ('awaiting_review','expired')` for both `replied=false` (send now) and `replied=true` (mark replied). Keep the parent-active guard (the parent stays `active` for expired items, so it passes). Update the claim filter + copy.

## UI

- **Outreach portal** (`outreach-shell.tsx`): add "Expires in N days" to the awaiting-review rows (emphasize as it nears 0). Render `expired` messages greyed + "Expired" label, but keep **Send now / They replied** live.
- **Contact page** (`contact-emails-tab.tsx`): `expired` follow-up messages show greyed + "Expired," visually distinct from a real sent email, with the **one-click Send now / They replied** retained (Dawson's explicit requirement). New columns flow to both via the existing `*` select on `email_follow_up_messages`.

## Docs (rule 34) + tests

- **Docs:** update `careervine/public/docs/index.html` #followup section — nudges, the 14-day countdown, and "expired follow-ups stay on the contact and can still be sent." No em dashes (rule 35).
- **Tests (Vitest, rules 3/4):** nudge-cron state machine (engagement flag, expiry incl. the grace branch, cadence day4/day9, per-user digest batching, opt-out suppression, no-nudge-after-14d); confirm route accepts `expired`; unsubscribe route (valid/invalid token); `web_last_seen_at` throttle; UI expired rendering + sendability.

---

## Build order (one CAR-105 PR, dark until the cron + UI land)

A. Schema + park-write stamp (dark). → B. `web_last_seen_at` stamping (dark). → C. Resend primitive + opt-out (settings toggle, unsubscribe route). → D. Nudge cron + QStash schedule. → E. UI (countdown, expired states) + confirm-route extension + docs. Then sync main, tests + build, PR.

## Decisions for you (my calls — veto any)

1. **Email cadence (confirmed):** day 0 (parked) + day 4 + day 9; none after expiry (day 14).
2. **Sender:** `CareerVine <notifications@careervine.app>`.
3. **Opt-out:** single `followup_nudges_enabled` boolean + settings toggle + one-click `List-Unsubscribe`.
4. **Digest batching:** one email per user per run covering all their due items (never one email per item).
5. **Active-aware edge:** if a user *never* returns after the window, the item never expires (stays in the portal). Confirmed intent?

## Out of scope

Paid-tier reconnect-to-upgrade (Phase 2 / D1 fix), recipient-side threading (CAR-104). SMS/push nudges (email only).

---

## Audit corrections (2026-07-12) — folded in; supersede conflicting text above

A two-agent read-only audit against the merged CAR-102 code caught real bugs and wrong assumptions. Resolutions:

**Status model (load-bearing).** Keep parent `email_follow_ups.status = 'active'` for a sequence containing an `expired` message (a parent-level `expired` would touch 8+ `.eq(status,'active')` reads and mis-mark multi-step/upgraded sequences). The price, which MUST be paid or "expired stays sendable" breaks:
- **Completion counts must count `expired` as open** — add `'expired'` to `.in("status", […])` at `confirm/route.ts:121` and `send-follow-ups/route.ts:271`. Else sending one message auto-completes the parent while an expired sibling remains, and the parent-active guard then 409s that sibling forever (confirmed critical bug).
- **Confirm route must accept `expired`** at BOTH the status guard (`:55`) and the atomic claim (`:77`) → `IN ('awaiting_review','expired')`; the error-revert (`:100`) restores the prior status, not a hard-coded `awaiting_review`.
- **Every teardown-cancel must also clear `expired`**: `follow-up-reply.ts:42` (reached by "They replied"), `send-follow-ups:155,200`, `gmail.ts:1012`, `mcp/lib/db.ts:996`, `email-follow-ups/[id]:31`, `gmail/follow-ups/[id]:114`.
- **Do NOT overload `isOpenFollowUpMessage`** (`constants.ts:25` = [pending, awaiting_review]) — it drives "N scheduled" UI counts + rebuild-delete-on-edit. Add a separate `UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES = [pending, awaiting_review, expired]` for the completion counts + teardown cancels. Leave the plan-edit rebuild-delete (`gmail/follow-ups/[id]:44`) on [pending, awaiting_review] so an edit never deletes a sendable expired message.

**Grant posture (silent-no-op fix).** `web_last_seen_at` is stamped from the RLS-scoped cookie client, so `GRANT UPDATE (web_last_seen_at) ON users TO authenticated` (mirror `extension_last_seen_at` at `20260711140000:41`) or the write no-ops. Same for `followup_nudges_enabled` if the settings toggle writes browser-side. The unauthenticated unsubscribe route uses the service client.

**Cadence engine (elapsed-day-driven + atomic).** Milestone eligibility off absolute elapsed days from `parked_at` (`target = now>=P+9d?3 : now>=P+4d?2 : now>=P?1 : 0`), not a bare counter. Each run, for `awaiting_review` with `reminder_count < target` and `now < P+14d`: **atomically claim** (`UPDATE reminder_count = target, last_reminder_at = now WHERE reminder_count < target RETURNING`), build the per-user digest from claimed rows, then send. This skips missed milestones (no stale day-0 back-send), is idempotent against QStash at-least-once retries (claim-before-send, mirroring existing send claims), and collapses to ONE stage-agnostic digest template ("N follow-ups awaiting your review"). Add a Resend `Idempotency-Key` (user + date).

**Expiry ordering + grace.** Send due emails BEFORE the expiry flip in a run (so day-9 isn't eaten at `now≥P+14d`). Grace sets `expires_at = web_last_seen_at + 24h` **once** (`WHERE expires_at <= parked_at + 14d`), else a daily-returning user never expires. `seen_during_window` relies on daily cron sampling; mis-classification only delays expiry (errs safe).

**Backfill.** Existing `awaiting_review` rows: `parked_at = COALESCE(scheduled_send_at, created_at)`, `expires_at = parked_at + 14d`, `reminder_count = 3` (suppress retroactive emails; still get countdown + expiry).

**UI heavier than stated.** Contact page (`contact-emails-tab.tsx`) has only read-only badges + a thread-level "Mark as replied" today — per-message **Send now / They replied is NET-NEW** (build for awaiting_review + expired; expired greyed). Portal (`outreach-shell.tsx`) needs a dedicated expired selector (buttons render only for `awaiting_review` today) + "X of Y sent" must not count expired as sent. `inbox-shell.tsx` (post-downgrade surface) needs an `expired` chip branch. Nav badge (`awaiting-review/route.ts:17`) includes `expired`.

**Plumbing confirmed.** QStash schedule via REST API with `$QSTASH_TOKEN` (self-service). `RESEND_API_KEY` absent from app runtime → add to Vercel + `NUDGE_UNSUBSCRIBE_SECRET`. No HMAC helper → write a small `crypto.createHmac` sign/verify (constant-time). Day-0 rides the daily digest (≤24h latency; run cron early-morning) — inline-at-park would break per-day batching.

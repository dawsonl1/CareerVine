# CAR-215 — Exact-time email delivery: A1 watcher + real per-user timezones

Two root causes make CareerVine miss the send times users pick. They are fixed
together because the second one silently invalidates any fix for the first: you
cannot deliver "9:05 AM their time" correctly while the stored timezone is wrong
for 3 of 8 users.

## Problem 1 — delivery is late because we poll for it

The QStash trigger is punctual. Measured against the live event log: schedules
fire within ~0.5s of the tick (`:00.069`, `:15.000`, `:30.231`, `:45.067`) and
the route returns 200 about 2s later. Every bit of observed lateness is the
`*/15` (scheduled emails) / `*/10` (follow-ups) poll interval.

Worse, the app's own 9:05 AM default lands 10 minutes *after* a `:00/:15/:30/:45`
tick, so the most common path is systematically the worst case rather than the
average one.

## Problem 2 — the stored timezone is a lie for some users

`gmail_connections.calendar_timezone` was added with
`DEFAULT 'America/New_York'` (`20260218090000_google_calendar_integration.sql:8`),
so any connection that never ran a calendar sync reads Eastern regardless of
where the user actually is.

Live data at time of writing: 4 rows read `America/New_York`, but only **one**
is real (calendar-synced 2026-07-20). The other three are the default, including
one of Dawson's own accounts whose sibling row says `America/Edmonton`. Verified
distribution among rows with a real sync behind them: 3 Mountain, 1 Pacific,
1 Eastern.

Two consequences, one of them already user-visible:

- **Live bug.** `calendar/availability/route.ts:48` reads
  `calendar_timezone || DEFAULT_TIMEZONE`, and `DEFAULT_TIMEZONE` is *also*
  Eastern. Those three users are being offered meeting slots in the wrong zone
  today.
- **DST drift.** `email-follow-ups/route.ts:82-89` bakes a client-supplied
  `timezoneOffsetMinutes` snapshot into every future step's UTC timestamp. A
  sequence created in EDT with a step landing after November's change sends at
  8:05 AM instead of 9:05. The 21-day step is the most exposed.

## Design

### Delivery: the A1 becomes the clock, Vercel stays the brain

A daemon on `personalhub-a1-1o-6g` polls the two queue tables directly every
~15s and POSTs the existing cron route **only when something is actually due**.

Why this shape and not the obvious one: having the A1 curl the cron endpoint on
a tight loop would be 2,880 Vercel invocations/day, and Fluid bills active CPU
against a 4 Active-CPU-hr/month Hobby budget that bundle-sync and calendar
polling already dominate (CAR-106). Watching Postgres instead means empty ticks
(the overwhelming majority) cost Vercel nothing, so invocations drop to roughly
one per batch of real email. That is *below* today's 96/day of empty polls, so
this frees Fluid budget rather than spending it.

The due query is already indexed: `idx_scheduled_emails_pending` on
`(status, scheduled_send_at) WHERE status = 'pending'`.

**Discipline: the A1 is a clock, not a scheduler.** It decides *when* to poke and
nothing else. All send logic stays in the Next app where it is tested. The moment
the box starts deciding *what* to send, the logic is split across two deploys and
two release processes.

**Least privilege.** The Supabase service role key must not land on the VM. A
dedicated read-only Postgres role gets SELECT on just the timing columns
(`id, user_id, scheduled_send_at, status`) of the two queue tables. The watcher
can see when to poke and literally nothing else; the send itself needs a separate
bearer.

**Rejected alternative — QStash one-off arming.** Publishing a message per email
with `Upstash-Not-Before` also gives exact delivery, but needs an arming pass, a
creation-time arm, a stored message id, cancel-on-edit, and horizon math, all to
stay under a free-tier ceiling of 500 messages/day and a verified `maxDelay` of
604800s (7 days). The A1 has no ceiling and needs none of that machinery.

### Failure handling: assume the box dies

Free-tier Oracle instances can be reclaimed with no recovery path, and the
ampere-poller precedent shows they fail *quietly* (it provisioned a VM and logged
nothing). So:

1. **QStash stays, demoted to an hourly safety net.** A1 down means delivery
   degrades to hourly, never to zero. The existing CAS claim
   (CAR-134 / CAR-179) already makes two concurrent drivers safe, so no new
   concurrency work is needed.
2. **Alerting is external, because a dead box cannot report its own death.** A
   BetterStack heartbeat monitor emails `dawsonlpitcher@gmail.com` when pings
   stop. The watcher pings it each loop.
3. **Second layer inside the app.** The hourly safety net notices the A1 has not
   poked recently and emails via Resend, catching the case where the box is alive
   but the daemon is wedged.

### Timezone: ask, don't assume

- New nullable `users.timezone` (IANA). **No default** — the whole bug is a
  default that reads as data.
- The client attaches `X-CV-Timezone` from
  `Intl.DateTimeFormat().resolvedOptions().timeZone` in `apiFetch`/`apiSend`.
- The server persists it in `api-handler.ts` alongside the existing throttled
  `web_last_seen_at` stamp (same best-effort, never-blocks-the-request pattern,
  same ~1/hour throttle, one extra column in the same UPDATE). Validate it is a
  real IANA zone before writing.
- The follow-up scheduler computes each step's 9:05 local **for that step's own
  date** in the stored zone, so a DST boundary between creation and send no
  longer shifts it.
- Drop the misleading `DEFAULT` on `gmail_connections.calendar_timezone` and fix
  the availability route's silent Eastern fallback.
- No backfill: the three unknown users cannot be inferred, and they self-populate
  on next visit.

## Work

1. Migration — `users.timezone` (nullable, no default), drop the
   `calendar_timezone` default, `GRANT UPDATE(timezone)` for the self-stamp path.
2. Client — `X-CV-Timezone` in `apiFetch`/`apiSend`, merging headers so a
   caller's `init.headers` is not clobbered.
3. Server — validate + persist the zone in `api-handler.ts`.
4. Follow-up scheduler — IANA-based 9:05 computation, replacing the offset
   snapshot. Availability route fallback fixed.
5. Migration — least-privilege watcher role.
6. `qstash-verify.ts` — accept a `CRON_TRIGGER_SECRET` bearer alongside the
   QStash signature, constant-time compare. Vercel env + redeploy.
7. A1 — watcher daemon, systemd unit with restart policy, `EnvironmentFile`
   chmod 600, heartbeat ping each loop.
8. BetterStack heartbeat monitor → email. In-app staleness alert via Resend.
9. QStash → hourly for both send schedules.

## Copy that must move with this change

Per CLAUDE.md, changing `scripts/qstash-schedules.mjs` cascades, and
`cron-schedules-registry.test.ts` fails on a miss:

- the cron expressions pinned in `cron-schedules-registry.test.ts`
- follow-up and scheduled-email cadence prose in `careervine/README.md`
- the docs page cadence prose and the follow-ups feature-card tag
  (`careervine/public/docs/index.html`)
- both interval cron routes' header comments
- `send-scheduled-emails` retry route comment, which claims the ~15 min cron is
  the sole send driver

The user-facing claim changes from "every 15 minutes" to something like "within
seconds of the time you pick", which is a stronger promise and needs to be true
before it ships. No em dashes in any of it (rule 35).

## Verification

- A follow-up scheduled across a DST boundary lands at the intended local
  wall-clock time (test pins a September creation with a November step).
- A user with no calendar connection gets their real zone stored on first API
  call, and the availability route stops defaulting them to Eastern.
- Armed-path latency: a row scheduled for T is sent within ~15s of T.
- Kill the daemon: delivery still happens on the hourly safety net, and the
  heartbeat alert fires to email.
- Two drivers racing the same row send exactly once (existing CAS coverage).
- `npm run test`, `npm run build`, and `npm run check:conventions` from
  `careervine/`.

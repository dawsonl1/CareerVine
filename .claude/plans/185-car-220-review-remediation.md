# CAR-220 — Remediate everything the CAR-215 deep review found

Eight discovery agents (5 scope, 1 integration, 2 behavioral) reviewed PR #195.
~38 real findings, 5 critical and live. Everything gets fixed here; nothing is
deferred to a follow-up ticket.

## Order of work, and why

Finding 1 ships real cold email to real contacts at the wrong moment, so it goes
first. Everything else is sequenced by whether it interlocks with another fix.

### Stream 1 — Scheduling correctness (critical 1; also 17, 18)

The modal computes its minimum delay in raw 24-hour buckets; the server computes
from the local calendar date at the local hour. They disagree, and only the MCP
path clamps to the future.

- **Server guard is the load-bearing half.** `buildFollowUpMessageRows` refuses
  to emit a past instant. The client fix alone would leave MCP, the edit path,
  and any future caller exposed. Clamp forward a whole local day rather than to
  `now`: a step the user asked to land at 09:00 should land at 09:00, tomorrow,
  not at 14:32 today.
- `minDaysForFirst` in the modal becomes local-calendar and sendTime aware, so
  the preview stops promising a time the server will reject.
- Unify the default send time: `/api/email-follow-ups` uses 09:05 and the modal
  hardcodes 09:00. Before CAR-215 both were 09:00 UTC, so this split is new.
- Edit mode seeds `sendTime` from the stored `scheduled_send_at` rendered in the
  resolved zone, instead of hardcoding 09:00 and silently rewriting every step.

### Stream 2 — Auth and DB privileege scope (critical 2, 3; also 22–25)

- `withQStashVerification` takes `{ allowCronBearer }`, set only on the two send
  routes. The daemon only ever calls those two, so scoping costs nothing.
- Migration: `REVOKE ALL ON FUNCTION due_send_counts() FROM PUBLIC, anon,
  authenticated`. `REVOKE FROM PUBLIC` never touched the explicit grant Supabase
  attaches at CREATE.
- Same migration: seed the `send-watcher` heartbeat row so "no row" stops being
  a valid state (finding 9), drop the no-op `ALTER DEFAULT PRIVILEGES` line
  whose comment claims protection it does not provide, and make the policy
  re-runnable.
- `grant-lockdowns.itest.ts` gains an `authenticated` leg. Its `anon`-only sweep
  is why finding 3 shipped green — Supabase's function defaults grant to
  `authenticated` and never to `anon`, so the guard checked the one role that
  never receives the automatic grant.
- `route-auth-inventory.test.ts` records the real mechanism per route.

### Stream 3 — Delivery safety (critical 4, 5; also 6, 7)

- The "one send per sequence per tick" deliverability guard becomes **time**
  based rather than tick based. A rate limit expressed in ticks silently inverts
  when you speed the clock up 40x, which is exactly what happened.
- `notifyOwner` gets an `AbortSignal.timeout`, and `checkWatcherHealth` moves
  **after** the sweep. Today the alert about degraded delivery can consume the
  60s budget of the only thing still delivering.
- `detectBounces` cancels matching `scheduled_emails`. The comment already
  claims it does; it never wrote that table, so a bounced scheduled email is a
  permanent poison row.
- `RouteState`'s progress signal stops being scalar count equality. One poison
  row currently pins the baseline and taxes *other* users' mail up to 900s.
  `due_send_counts()` also returns the oldest due instant; a change there counts
  as progress. Plus an unconditional minimum inter-trigger interval that a count
  change cannot clear.

### Stream 4 — Watcher daemon (11–14, plus small items) — delegated

Boot-relative `monotonic` vs a `0.0` sentinel (floor-sweeps on every start),
missing `statement_timeout`/keepalives, DSN password leaking into the journal on
a malformed value, and `trigger()`'s discarded return letting a totally broken
watcher beat BetterStack green.

### Stream 5 — Timezone validation and the DST spec (15, 16) — delegated

`isValidIanaTimeZone` accepts fixed-offset pseudo-zones that never observe DST.
And the documented gap/overlap invariants were generalized from a single zone;
they invert for 73 of 130 zones with a 2026 transition. The arithmetic is sound
(74,880 wall clocks round-trip exactly) — only the claim is wrong.

### Stream 6 — Copy, comments, and the reassurance sweep (19–21, 26)

Two live toasts promising "within 15 minutes", six "sole send driver" comments,
`CONVENTIONS.md`'s now-false cron-auth section, and the `STALE_CADENCE` guard
that scans two files while claiming to cover every surface.

## The thing actually worth fixing

Seven places asserted a property the code did not have. Not one was a coding
error; all seven were confident prose that made the next reader skip the check:

| Claim | Reality |
| --- | --- |
| "authorizes exactly one thing … not data access" | 9 routes |
| "no surface still advertises a polling interval" | scans 2 files |
| "a future blanket GRANT won't reach this role" | proven no-op |
| "the two drivers watch each other" | one direction implemented |
| "the BetterStack heartbeat covers this case" | blind to that path |
| "a cached older client is harmless" | 3:05 AM sends |
| "gap resolves pre-jump, verified empirically" | verified one zone |

Every one gets corrected to what the code does. Where the claim was worth making
true, the code changes instead. Comments that assert a safety property are now
treated as claims requiring evidence, not as documentation.

## Verification

- The Denver reproduction must go from "3h in the past, sent immediately" to a
  future instant at the requested local hour.
- Bearer must 401 on all seven non-send routes and 200 on the two send routes.
- `has_function_privilege('authenticated', 'due_send_counts()', 'EXECUTE')` must
  be false on production.
- Three due steps in one sequence must space out in time, not by tick.
- Every fix lands with a test that fails without it. Falsify each one.
- `npm run test`, `test:integration`, `tsc --noEmit`, `eslint`,
  `check:conventions`, `build`.

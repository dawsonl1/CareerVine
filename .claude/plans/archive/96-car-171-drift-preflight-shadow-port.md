# CAR-171: Clear failure when a local Supabase stack holds the shadow port

## Problem

`scripts/supabase-prod-drift-check.sh` is correct and fail-closed, but when a
local Supabase stack is running it holds port 54320 (`shadow_port` in
`supabase/config.toml`). `supabase db diff` then cannot provision its shadow
database and the script:

1. retries 3 times (9 wasted seconds) on a deterministic port conflict, and
2. reports "prod connection / link / CLI issue" while the real cause (port
   conflict, fix: `supabase stop --project-id careervine`) is buried in the
   stderr dump.

Since `supabase-prod-push.sh` runs this as a blocking pre-flight, a developer
with a local stack running cannot push migrations and is told the wrong reason.

## Fix (keeps fail-closed posture exactly as is)

1. **Pre-check before `db diff`**: parse `shadow_port` from
   `supabase/config.toml` (default 54320) and probe it with bash's `/dev/tcp`.
   If something is listening, exit 1 immediately with a one-line actionable
   message: the shadow port is in use, likely a local `supabase start` stack;
   stop it (`supabase stop --project-id careervine`) or change `shadow_port`.
2. **Mid-run detection**: if `db diff` still fails with the shadow-provision
   signature (`LegacyDeclarativeShadowDbError` / "failed to provision the
   shadow database"), break out of the retry loop on the first attempt and
   print the same targeted message instead of the generic
   "prod connection / link / CLI issue" one.
3. **Not doing** the ticket's optional auto-pick-a-free-port: it would mean
   mutating the checked-in `config.toml` at runtime (a killed run leaves the
   tree dirty), and the actionable message already unblocks the developer in
   one command.

## Tests

New `careervine/src/__tests__/prod-drift-check-script.test.ts` runs the real
script with stub `docker`/`supabase` executables on a prepended PATH (no Docker
needed), using a `DRIFT_CHECK_SHADOW_PORT` env override (test hook, documented
in the script) so the test can bind an ephemeral port:

- port occupied → exit 1, message names the shadow port conflict and the fix,
  and the stub `supabase` is never invoked
- port free + stub emits clean diff JSON → exit 0
- port free + stub emits the `LegacyDeclarativeShadowDbError` JSON → exit 1
  with the targeted message, and the stub runs exactly once (no retries)
- port free + stub fails generically → existing 3-attempt retry + generic
  fail-closed message unchanged

## Verification

- `npm run test` from `careervine/` green
- Manual: with the local stack running, script fails fast with the port
  message; with it stopped, script exits 0 against current main (real run)

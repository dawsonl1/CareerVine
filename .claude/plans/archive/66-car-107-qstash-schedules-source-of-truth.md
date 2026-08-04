# Plan 66 — CAR-107: QStash schedules source-of-truth

## Why

All six QStash cron schedules live only in the Upstash console. No repo record of the cron expressions / destinations / retries, no drift detection, no way to recreate them if the account is lost. Surfaced in CAR-106, where reconstructing the schedule set needed a live API read. Follow-on cleanup.

## What

`careervine/scripts/qstash-schedules.mjs` (standalone ops script, not imported by the app):
- Declarative `SCHEDULES` array (the source of truth), seeded from the current live state so it matches production exactly:
  - `send-follow-ups` `*/10 * * * *`, `send-scheduled-emails` `*/15 * * * *`, `sync-bundles` `0 12 * * *`, `scrape-refresh` `0 9 * * *`, `discovery` `0 10 * * 1`, `storage-sweep` `0 10 * * *` — all retries 3, POST, host `https://www.careervine.app`.
- `list` (default, read-only): GET live schedules, match by destination path, print in-sync / drift (cron or retries) / missing, and flag undeclared live schedules. Exit non-zero on any drift so it can gate CI.
- `sync` (explicit): create missing, fix drifted (create-new-then-delete-old so there's never a gap), never auto-delete undeclared extras (warn only). Prints a plan.
- Region-pinned base `https://qstash-us-east-1.upstash.io/v2`; reads `QSTASH_TOKEN`.
- Update the cron route docstrings that say "create the schedule in the Upstash console" to point at the script.

## Verify

- `node scripts/qstash-schedules.mjs list` against production shows all six in sync (proves the declaration matches reality) and exits 0.
- `npm run test` + `npm run build` green (docstring-only route edits, no behavior change).

## Risk

The script only writes when a human runs `sync`; nothing runs at app runtime. Seeded from live, so `list` is clean and the first `sync` is a no-op. Extras are never auto-deleted.

# CAR-180 — Destructive-migration guard misses `DELETE FROM ONLY`

## Problem

`careervine/src/__tests__/migration-destructive-guard.test.ts` (the CAR-175 guard) scans migrations with:

```js
/\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)\s+(?:"?public"?\.)?"?([a-zA-Z_]\w*)"?/gi
```

The `TRUNCATE` alternative accepts an optional `ONLY`, but `DELETE FROM` does not. For `DELETE FROM ONLY calendar_events`, the capture group grabs `only` as the table name, which isn't in `APP_OWNED_COLUMNS`, so the statement is skipped entirely. `DELETE FROM ONLY <table>` is valid Postgres and behaves identically to `DELETE FROM <table>` on a non-partitioned table, so a repair migration phrased that way would reproduce the exact CAR-152 data loss the guard exists to prevent, silently.

## Fix (test file only — no app code, no migration)

1. Add the `ONLY` branch to the `DELETE FROM` alternative:
   ```js
   /\b(?:DELETE\s+FROM(?:\s+ONLY)?|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)\s+(?:"?public"?\.)?"?([a-zA-Z_]\w*)"?/gi
   ```
2. Pin the gap closed: add `DELETE FROM ONLY calendar_events;` (and a quoted/public variant) to the rejects-fixtures block.

## Verification

- Inject → red first: add the fixture before the regex fix and confirm the guard fails on it; then apply the regex fix and confirm green.
- Full `npm run test` from `careervine/` stays green.

## Out of scope

DROP TABLE / DROP COLUMN scanning — two audit verifiers rejected these as a different destructive class than the delete-and-resync shape CAR-175 covers. Recorded on the ticket as possible future widening only.

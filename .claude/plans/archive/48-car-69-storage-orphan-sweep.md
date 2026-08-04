# CAR-69 — Clean up orphaned storage blobs when attachments rows are cascade-deleted

## Problem

Cascade deletes (user deletion via CAR-66, contact/meeting deletion) remove `attachments` DB rows but never touch the underlying Supabase Storage objects, leaving orphaned blobs. The admin user-delete route (`careervine/src/app/api/admin/users/[id]/route.ts`) is the primary orphan generator: `auth.admin.deleteUser()` cascades the DB and skips storage entirely. The same pattern applies to the `application-files` bucket (tracked by `pipeline_applications.resume_path` / `cover_letter_path`).

## Approach (per ticket recommendation)

Reconciliation sweep as the safety net + best-effort inline storage delete in the explicit delete paths.

### 1. Sweep lib — `careervine/src/lib/storage-sweep.ts`

Pure function with injected service client (mirrors `scheduled-email-cron.ts` DI pattern for testability):

- Buckets swept and their sources of truth:
  - `attachments` → `attachments.object_path` where `bucket = 'attachments'`
  - `application-files` → `pipeline_applications.resume_path` ∪ `cover_letter_path`
- Recursively walk each bucket via `.storage.from(bucket).list()` (paginated, folder-recursive since keys are `{userId}/{filename}`).
- An object is an orphan iff its exact path has no matching DB row (exact string match — `file.name` can contain arbitrary chars, never prefix-parse).
- **Min-age guard:** skip objects created < 24 h ago. `uploadAttachment` uploads *before* inserting the row, so a sweep mid-upload would otherwise see a false orphan.
- Delete in batches of 100 via `.remove()`; log every removed path; return `{bucket: {scanned, live, removed[], skippedRecent}}`.
- Idempotent by construction (re-listing after delete finds nothing).

### 2. Cron route — `careervine/src/app/api/cron/storage-sweep/route.ts`

Thin wrapper mirroring the four existing QStash routes: module-scope `Receiver` with `QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`, raw-body signature verify → 401, `withCronGuard("storage-sweep", ...)`, `createSupabaseServiceClient()`, `maxDuration = 60`, JSON summary response.

### 3. Inline cleanup in admin user-delete route

In `api/admin/users/[id]/route.ts` DELETE: before `auth.admin.deleteUser()`, best-effort remove the user's `{userId}/` folder contents in both buckets (list + remove, errors swallowed — the sweep self-heals misses). The browser-side `deleteAttachment()` in `queries.ts` already removes storage first; no change needed there.

### 4. One-off audit of existing orphans — `careervine/scripts/sweep-storage-orphans.mjs`

Mirrors `migrate-photos-to-r2.mjs` conventions: service client from `.env.local`, dry-run by default, `--apply` to delete. Run the audit against production (dry-run → review → apply), confirming the `_smoke/<uuid>.txt` candidate from CAR-66. Same min-age guard.

### 5. Tests

- `storage-sweep.test.ts`: mock service client (storage `list`/`remove` + query builders) — orphan detected & removed, live object untouched, recent object skipped, pagination, both buckets, remove-error surfaces in result.
- Extend admin route test for the new storage cleanup call.

### 6. Ops (Claude-owned, post-merge)

- `supabase db push` — none needed (no migrations in this ticket).
- Create QStash schedule `storage-sweep` daily (off-peak, 10:00 UTC) via `$QSTASH_TOKEN` against `https://www.careervine.app/api/cron/storage-sweep`.
- Run the one-off audit script against production; report what was removed on the ticket.

## Acceptance mapping

- User/contact/meeting deletion leaves no storage objects after next sweep → sweep covers both buckets; inline delete covers immediacy for admin user-delete.
- Idempotent, logs removals, never deletes an object with a matching row → exact-path diff + min-age guard + per-path logging.

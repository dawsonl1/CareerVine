# CAR-156 — PII deletion completeness

Wave 5 / T19 of the Straight A's program. Retires R4.3, R4.5, R4.6, R4.7 plus the R2 orphan sweep and the privacy drift guard. CAR-146's data modules are on main, so `deleteMeeting` lives in `src/lib/data/meetings.ts`.

## 1. Google grant revocation on admin delete (R4.3) + calendar cache on revoke (R4.6)

- `src/lib/gmail.ts` `revokeAccess`: also delete `calendar_events` for the user (mirrors `api/calendar/disconnect`). After a full Google disconnect the OAuth grant is dead, so cached event titles/attendees must not survive.
- `src/app/api/admin/users/[id]/route.ts` DELETE: call `revokeAccess(id)` wrapped in try/catch (best-effort) BEFORE `service.auth.admin.deleteUser(id)` — after deleteUser the encrypted token is cascade-destroyed and the grant becomes permanently unrevokable at Google.
- Correct the route's "cascades into all of the user's data" comment: name the explicit steps (grant revocation, storage, R2) and the analytics cascade added in §3.

## 2. Meeting artifact deletion (R4.7)

`deleteMeeting` in `src/lib/data/meetings.ts`, before removing the meeting row:

1. Read `meetings.transcript_attachment_id` and `meeting_attachments` rows → candidate attachment ids.
2. Shared-reference guard (batched `.in()` probes): skip any candidate still referenced by `contact_attachments`, `interaction_attachments`, another meeting's `meeting_attachments` link, or another meeting's `transcript_attachment_id`.
3. Fetch `object_path` for the deletable ids and run each through the existing `deleteAttachment` path (storage object + row; junction rows cascade; `transcript_attachment_id` is ON DELETE SET NULL so ordering is safe).

This is the only path that frees raw meeting audio — the storage sweep can't reclaim it while the attachment row survives.

## 3. Analytics cascade migration (R4.5)

New migration `20260719000000_car156_analytics_user_cascade.sql`:

- Delete orphaned `analytics_events` / `user_milestones` rows (users deleted while the tables were FK-less) so validation passes.
- `ADD CONSTRAINT ... FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE` on both tables (same pattern as `20260711130000_user_deletion_cascade.sql`).

Rule 32 rehearsal (BEGIN / lock_timeout / apply / ROLLBACK against prod) before shipping. Because the FK shows up in `database.types.ts` Relationships and CI has a types-drift gate, apply the migration for real at PR time (additive constraint, rule 42-safe: no deployed code depends on its absence), then `gen:types` and commit the regenerated types in the same PR.

## 4. R2 orphan sweep

- `src/lib/r2.ts`: add prefix-listing (`careervine/contact-photos/`, keys + LastModified) and batched-delete helpers.
- `src/lib/storage-sweep.ts`: `sweepR2PhotoOrphans` reusing the sweep's safety properties — list R2 first, then build the complete live set from `contacts.photo_url` (paginated, `.order("id")`, any read error aborts the pass), exact-key matching via `r2KeyFromPublicUrl`, 24h min-age with unknown-age-fails-safe, batched deletes, dry-run support.
- `api/cron/storage-sweep` route: run the R2 pass after the Supabase buckets and report its counts in the response.

## 5. Privacy page + drift guard

- `src/app/privacy/page.tsx` Section 4: add a Cloudflare R2 subprocessor entry (currently only alluded to as "our content delivery network" in Section 7). No em dashes (rule 35).
- CLAUDE.md: append Learned Rule 46 — any change to what is persisted about users or third parties must update `privacy/page.tsx` in the same PR (extends rule 34's docs-drift spirit to the privacy policy).

## Tests (exit criteria)

- New admin user delete route test: spy-ordering (revokeAccess before deleteUser), revoke failure doesn't block deletion, storage cleanups still run.
- revokeAccess test: `email_messages` AND `calendar_events` both deleted; disconnect tests stay green.
- deleteMeeting tests: meeting with a recording removes attachment row + storage object; a shared attachment survives.
- R2 sweep tests: old orphan deleted, live/young/unknown-age keys kept, contacts read error aborts with no deletes, R2 list error aborts, cron response carries R2 counts.
- Analytics cascade: verified by the rolled-back prod rehearsal (insert-free — constraint validation runs against real data) + the applied migration; delete-route comment made truthful.
- Full `npm run test` + `npm run build` from `careervine/`.

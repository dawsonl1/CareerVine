# CAR-24 — Contact Profile Photo Storage for All Accounts

## Problem

`contacts.photo_url` already exists and is rendered in list/detail UI, but users do not have a direct in-app way to upload or remove profile photos for manually created contacts. Photos are currently populated primarily via import flows.

## Goals

1. Enable users to upload a profile photo from their device for any contact.
2. Persist uploaded photos in Supabase Storage (`contact-photos`) and store the resulting URL in `contacts.photo_url`.
3. Allow users to remove an existing profile photo.
4. Ensure the flow works consistently for all user accounts and existing contact records.
5. Add validation and test coverage for new logic.

## Non-goals

- Building image cropping/editing tools.
- Backfilling historical contacts automatically.
- Changing existing avatar rendering behavior outside upload/remove integration.

## Current State Summary

- `ContactAvatar` already supports `photoUrl` fallback behavior.
- `contacts` table already has `photo_url`.
- Import flow has a helper (`downloadAndStorePhoto`) that writes to `contact-photos`.
- No user-facing file upload/remove action exists in main contact creation or editing flows.

## Proposed Solution

### 1) Add reusable photo helpers

Create `src/lib/contact-photo.ts` with:

- `MAX_CONTACT_PHOTO_BYTES` constant (5MB).
- `ALLOWED_CONTACT_PHOTO_TYPES` constant (`image/jpeg`, `image/png`, `image/webp`, `image/gif`).
- `validateContactPhotoFile(file: File): string | null` returning user-readable error message or `null`.

Purpose: keep validation logic centralized and testable.

### 2) Add query-layer storage operations

In `src/lib/queries.ts`, add:

- `uploadContactPhoto(userId: string, contactId: number, file: File): Promise<string>`
  - Validate file type/size via helper.
  - Upload to `contact-photos` with deterministic path `${userId}/${contactId}.jpg` and `upsert: true`.
  - Read public URL and append cache-busting query param.
  - Update `contacts.photo_url` scoped by `id` + `user_id`.
  - Return updated URL.

- `removeContactPhoto(userId: string, contactId: number): Promise<void>`
  - Best-effort remove from storage path `${userId}/${contactId}.jpg`.
  - Update `contacts.photo_url` to `null` scoped by `id` + `user_id`.

### 3) Add user-facing photo controls on contact detail

Update `src/components/contacts/contact-profile-card.tsx`:

- Add hidden file input + "Upload photo" action near avatar.
- Add "Remove photo" action when a photo exists.
- Wire actions to new query helpers.
- Surface success/failure via existing toast system.
- Trigger `onContactUpdate()` after mutations.
- Keep interactions lightweight and consistent with current UI patterns.

### 4) Ensure create/edit flows can support immediate photo assignment

For this ticket’s first pass, photo assignment will be guaranteed through contact detail page controls (where contact ID is available). If quick-add/create modal support is straightforward without degrading UX, add optional photo input there as a follow-up in the same PR; otherwise keep scope focused and reliable on detail page.

### 5) Add test coverage

Add `src/__tests__/contact-photo.test.ts` to cover:

- Accept valid image type/size.
- Reject unsupported mime type.
- Reject oversize file.
- Error messages are deterministic and user-friendly.

## Implementation Steps

1. Add photo validation helper module.
2. Add tests for helper module.
3. Implement query-layer upload/remove methods.
4. Add avatar upload/remove UI actions in `ContactProfileCard`.
5. Run test suite (`npm run test` in `careervine/`).
6. Manual smoke-check (logical): verify contact detail can upload/remove and refresh photo.
7. Update README with user-facing capability.
8. Commit and push with clear message.
9. Post completion notes and validation summary to Linear issue.

## Risks and Mitigations

- **Risk:** Storage object extension mismatch (`.jpg` path for non-jpeg content).  
  **Mitigation:** Keep deterministic path consistent with existing code; rely on content type metadata and avatar rendering via URL.

- **Risk:** Stale image due to CDN/browser caching.  
  **Mitigation:** Append cache-busting `?t=` query param after upload.

- **Risk:** File input UX clutter.  
  **Mitigation:** Keep controls compact and contextual in profile card.

## Validation Plan

- Automated: full Vitest suite passes.
- Functional:
  - Upload photo updates avatar immediately after refresh callback.
  - Remove photo returns to initials fallback.
  - Invalid file type/size shows clear toast error and does not call upload.


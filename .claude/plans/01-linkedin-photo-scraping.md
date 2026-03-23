# LinkedIn Profile Photo Scraping & Display

## Goal
Scrape LinkedIn profile photos during the extension's existing scrape flow, store them durably in Supabase storage (public bucket), and display them throughout the webapp — replacing the current initials-based avatars.

---

## Phase 1: Extract Photo URL in Chrome Extension

### 1a. Update `linkedin-scraper.js`
- Add a new method `extractProfilePhotoUrl()` that extracts the viewed profile's photo
- **Selector strategy** (audit-corrected): Do NOT use `img.presence-entity__image` — that's the logged-in user's nav avatar. Instead:
  1. Query `main img[src*="profile-displayphoto-shrink_400_400"]` (only appears for the viewed profile)
  2. Fallback: `main img[src*="profile-displayphoto-shrink_100_100"]` and rewrite URL to `shrink_400_400`
  3. Fallback: `main img[src*="profile-displayphoto-scale_100_100"]` and rewrite similarly
- **Ghost avatar detection**: Skip if URL does NOT contain `media.licdn.com/dms/image` (LinkedIn default silhouettes use a different path like `/aero-v1/sc/h/...`)
- Return `null` if no real photo is found
- Call this method alongside `scrapeAndClean()` so both text and photo URL are available

### 1b. Update `content.js`
- When `analyzeCurrentProfile()` fires, capture the photo URL from the scraper
- Include `photoUrl` in the message payload sent to the background service worker alongside `cleanedText` and `profileUrl`
- **Important**: `photoUrl` is DOM-scraped data, NOT AI-parsed — it bypasses the parse-profile API entirely

### 1c. Update `background.js`
- In the `parseProfile` action handler, store `photoUrl` separately in `chrome.storage.local` as `latestPhotoUrl` (NOT inside `latestProfile`, which comes from the AI parse response)
- In the `importData` action handler, read `latestPhotoUrl` from storage and include it in the import payload

### 1d. Update `panel-app/src/App.tsx`
- Read `latestPhotoUrl` from `chrome.storage.local` alongside `latestProfile`
- Display the photo in the profile preview card where the `<User>` icon currently appears
- Fallback to the existing `<User>` icon SVG if no photo URL exists
- Handle independently from webapp's ContactAvatar (panel uses Shadow DOM, not Tailwind)

---

## Phase 2: Backend — Store Photo

### 2a. Database migration
- Create new migration: `add_photo_url_to_contacts.sql`
- Add column: `ALTER TABLE contacts ADD COLUMN photo_url varchar;`
- This stores the full public Supabase storage URL

### 2b. Create public `contact-photos` storage bucket
- New migration to create a **public** `contact-photos` bucket (separate from private `attachments`)
- RLS policies: public READ, authenticated INSERT/DELETE restricted to user's own folder (`{userId}/...`)
- No UPDATE policy needed — use delete-then-insert for re-imports
- Public URLs are deterministic and never expire, eliminating the N+1 signed URL problem

### 2c. Update `/api/contacts/import/route.ts`
- Accept `photoUrl` as a top-level field alongside `profileData` in the request body
- **SSRF protection**: Validate that `new URL(photoUrl).hostname === 'media.licdn.com'` before fetching
- After creating/updating the contact record:
  1. Fetch the image from the LinkedIn CDN URL (with 3-second timeout)
  2. Upload to `contact-photos` bucket at path `{userId}/{contactId}.jpg`
  3. Get the public URL and store in `contacts.photo_url`
- Wrap in try/catch — photo failure must NOT block the import
- On re-import: delete existing photo first, then upload new one (no UPDATE RLS needed)

### 2d. Update `contactsImportSchema` in `api-schemas.ts`
- Add `photoUrl` as an optional top-level field: `photoUrl: z.string().url().optional()`

### 2e. No changes to `parse-profile/route.ts`
- Photo URL bypasses the AI parsing step entirely — it's DOM-scraped, not AI-parsed

---

## Phase 3: Webapp — Display Photos

### 3a. Update `queries.ts`
- `getContacts()` and `getContactById()` already use `select("*")` which will include `photo_url` automatically
- Add photo cleanup to `deleteContact()`: call `supabase.storage.from('contact-photos').remove([path])` before deleting the contact row

### 3b. Create a reusable `ContactAvatar` component
- Accepts: `name`, `photoUrl`, and `className` for sizing (not a size enum — matches codebase patterns)
- If `photoUrl` exists: render `<img>` with `onError` fallback to initials
- If no `photoUrl`: render current initials avatar
- Keep it thin — under 30 lines

### 3c. Update `contact-info-header.tsx`
- Replace the initials `<div>` at line 265 with `<ContactAvatar>`
- Pass `className="w-12 h-12"` to maintain current sizing

### 3d. Update `contacts/page.tsx`
- Replace initials avatars in contact list rows (line 363) with `<ContactAvatar className="w-10 h-10">`
- Replace initials in search suggestions (lines 287, 306) with `<ContactAvatar className="w-7 h-7">`

### 3e. Update TypeScript types
- Add `photo_url` to the contact type in `database.types.ts` (or regenerate types)

---

## Phase 4: Handle Edge Cases

### 4a. Re-scrape existing contacts
- When a contact is re-imported (duplicate detected, user chooses to update), delete old photo then upload new one
- Delete-then-insert pattern avoids needing an UPDATE RLS policy

### 4b. Default/missing photos
- LinkedIn silhouette/ghost profiles: detect by checking URL doesn't contain `media.licdn.com/dms/image` — skip these
- Fallback to initials avatar in all UI locations

### 4c. Contact deletion cleanup
- `deleteContact()` reads `photo_url`, extracts the storage path, and removes the file from `contact-photos` bucket before deleting the DB row

---

## File Change Summary

| File | Change |
|------|--------|
| `chrome-extension/src/content/linkedin-scraper.js` | Add `extractProfilePhotoUrl()` method |
| `chrome-extension/src/content/content.js` | Pass photo URL through scrape flow |
| `chrome-extension/src/background/background.js` | Store `latestPhotoUrl` separately, include in import |
| `chrome-extension/panel-app/src/App.tsx` | Show photo preview in side panel |
| `supabase/migrations/XXXXXX_add_photo_url.sql` | Add `photo_url` column |
| `supabase/migrations/XXXXXX_create_photo_bucket.sql` | Create public `contact-photos` bucket |
| `careervine/src/app/api/contacts/import/route.ts` | Download photo, store in bucket, save URL |
| `careervine/src/lib/api-schemas.ts` | Add `photoUrl` to import schema |
| `careervine/src/lib/queries.ts` | Add photo cleanup on contact delete |
| `careervine/src/components/contacts/contact-avatar.tsx` | New reusable avatar component |
| `careervine/src/components/contacts/contact-info-header.tsx` | Use `ContactAvatar` |
| `careervine/src/app/contacts/page.tsx` | Use `ContactAvatar` |
| `careervine/src/lib/database.types.ts` | Add `photo_url` to types |

---

## Implementation Order
1. Phase 2a + 2b (migrations) — do first since everything depends on storage
2. Phase 1 (extension changes) — can be done in parallel with Phase 2c-2d
3. Phase 2c-2d (backend import) — needs migrations applied
4. Phase 3 (webapp display) — needs backend working
5. Phase 4 (edge cases) — done alongside Phase 3

## Testing Plan
- Unit test: `extractProfilePhotoUrl()` against example HTML
- Integration test: import flow with and without photo URL
- Test SSRF protection: reject non-LinkedIn URLs
- Test ghost avatar detection: skip default silhouettes
- Manual test: full end-to-end scrape → import → display
- Edge case test: missing photo, re-import with new photo, contact deletion cleanup

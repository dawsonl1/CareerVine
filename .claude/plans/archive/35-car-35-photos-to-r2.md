# CAR-35 — Move contact photos to R2 + thumbnail resize (Supabase egress fix)

## Problem (diagnosed 2026-07-09)

- The July 8 PM scrape import mirrored **1,624 LinkedIn photos = 260 MB of full-res 800×800 JPEGs** (avg ~160 KB) into Supabase Storage `contact-photos/{dawson-user-id}/`.
- The contacts page loads **all** contacts (active+prospect+bench, no pagination — `contacts/page.tsx:104`) and renders each avatar as a raw `<img>` against the Supabase public URL (`contact-avatar.tsx`). One cold "Everyone" load ≈ 260 MB of cached egress.
- Result: 5.229/5 GB cached egress (105%) in ~2 days; Supabase free plan warning restrictions. Uncached (DB) egress is fine at 19% — bundle publish/sync machinery is NOT the problem.
- Bundle payloads carry `media.licdn.com` URLs that **expire ~July 22** (`e=1784764800`) — subscriber avatars are about to break. Subscribers currently get **no** photos anyway (`skipPhotos: true` in bundle sync; `photo_url` is only ever written by the mirror phase).
- Storage math: 260 MB/user of per-user mirrors caps the free 1 GB bucket at ~3 heavy users.

## Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where photo bytes live | **R2** `dawsonsprojects-assets` bucket, `careervine/` prefix | Global storage convention (visitor-facing assets → R2); egress through Cloudflare CDN is free; 10 GB free storage vs Supabase's 1 GB |
| Public serving | **Custom domain `assets.careervine.app`** attached to the bucket (zone `a9be83f1c6d5dc3222543d45cce1a668`) | Buckets are private by default; custom domain = public serving through CF CDN with caching. Note: this exposes the whole shared bucket (all prefixes) under this hostname — acceptable, every prefix is visitor-facing by convention |
| Image size | **256×256 cover WebP, quality 75** via `sharp` at write time (~8–15 KB each) | Largest avatar render is w-16 (64 px) @2x retina = 128 px; 256 gives headroom for the profile-card photo view. Supabase's on-the-fly transforms are a paid feature; resize-at-write is the free-plan architecture and also fixes client slowness. 260 MB → ~15 MB |
| Cache strategy | `Cache-Control: public, max-age=31536000, immutable` + **content-versioned keys** (hash in filename) | Kills the `?t=` cache-bust pattern; browsers/CDN cache forever; replacing a photo produces a new URL |
| User photo keys | `careervine/contact-photos/{userId}/{contactId}-{sha256(bytes)[:8]}.webp` | Per-user namespace preserved; hash suffix = version |
| Bundle photo keys | `careervine/bundle-photos/{sha256(bytes)[:16]}.webp` — **one shared copy** | N subscribers share 1 set of images; content-hash dedupes identical photos |
| Who mirrors bundle photos | **The publish driver script** (`scripts/publish-bundle.mjs`), pre-publish, locally | 1,600+ fetch+resize+upload cycles don't fit the 60 s serverless budget of the publish route; the driver already runs locally with full env. Payload contract unchanged (`photo_url` is just a URL — the CAR-24 comment in `bundle-payload.ts:89` anticipated exactly this swap) |
| Subscriber photo policy | Bundle sync writes the R2 `photo_url` **as a plain column value** (no download): set on create; on refresh only if current value is null or another `bundle-photos/` URL | Never clobbers a user's manual upload; safe because the fingerprint surface explicitly excludes `photo_url` (importer-owned) |
| S3 client | `@aws-sdk/client-s3`, server-only `lib/r2.ts` | Standard, reliable; R2 creds never reach the browser — client upload/delete moves behind API routes |
| Supabase `contact-photos` bucket | Emptied and retired after migration | `attachments` + transcript audio stay in Supabase (private, signed URLs, low volume) — out of scope |

## Implementation

### Phase 0 — Infra (no app impact, done before code lands)

1. Attach custom domain `assets.careervine.app` to `dawsonsprojects-assets` via R2 API (`$R2_API_TOKEN`); Cloudflare creates the DNS record automatically. Verify with a test object under `careervine/_test/`.
2. Env vars — add to Vercel (production + preview + development, project `careervine`) and `careervine/.env.local`:
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (values from `secrets.zsh`)
   - `R2_BUCKET=dawsonsprojects-assets`
   - `R2_PUBLIC_BASE_URL=https://assets.careervine.app`

### Phase 1 — Server plumbing

3. **`src/lib/r2.ts`** (new, server-only): S3 client from env; `putObject(key, bytes, contentType)` with immutable cache headers; `deleteObject(key)`; `r2PublicUrl(key)`; key-builder helpers for both schemes; `isBundlePhotoUrl()` / `isUserPhotoUrl()` predicates.
4. **`src/lib/photo-thumb.ts`** (new): `sharp` → 256×256 cover WebP q75; input validation (size cap, decodable image).

### Phase 2 — Rewire every photo write path

5. **`import-db-helpers.ts` → `downloadAndStorePhoto`**: keep the existing fetch guards (5 s timeout, 5 MB cap, content-type allowlist), then thumb → R2 put → update `contacts.photo_url` with the R2 URL (no `?t=`). Delete the previous R2 object if the contact had one (best effort).
6. **Client upload/delete → API routes** (R2 creds are server-only):
   - `POST /api/contacts/[id]/photo` — session auth, ownership check, `validateContactPhotoFile`, thumb, R2 put, delete old object, update row, return URL.
   - `DELETE /api/contacts/[id]/photo` — delete R2 object (or legacy Supabase object during the transition window), null the column.
   - `queries.ts` `uploadContactPhoto`/`removeContactPhoto` become thin `fetch()` wrappers; all `supabase.storage.from("contact-photos")` calls disappear from client code.
7. **`bulk-import.ts` (`importPeopleChunk`)**: when `mapped.photo_url` is a trusted bundle R2 URL, write it directly per the subscriber photo policy above (bundle path keeps `skipPhotos: true` for the download phase — no fetches during sync).
8. **`scripts/publish-bundle.mjs`**: pre-publish mirror pass — for each person with a `media.licdn.com` photo: fetch → thumb → R2 put (content-hash key) → swap payload `photo_url`. Local JSON cache (source URL → R2 URL) beside the bundle files so republish is incremental; fetch failures log and null the photo (licdn URLs die soon anyway).
9. **`contact-avatar.tsx`**: add `loading="lazy"` + `decoding="async"`.

### Phase 3 — Migration of existing data

10. **`scripts/migrate-photos-to-r2.mjs`** (new, runs locally against prod): page through contacts with Supabase-storage `photo_url`s → download → thumb → R2 put → update row. Concurrency ~8, idempotent/resumable (skips rows already on R2), `--dry-run` mode, summary report. Separate `--cleanup` pass deletes all Supabase `contact-photos` objects (including orphans) — run only after avatar spot-check passes.

### Phase 4 — Tests (`npm run test` from `careervine/`)

- `photo-thumb`: real sharp on a fixture image — output is WebP, ≤256 px, smaller than input.
- `r2`: key builders, public URL, predicates (pure logic; S3 client mocked).
- Photo API routes: 401 unauthenticated, 404 non-owned contact, happy path (mocked R2 + thumb).
- `bulk-import` photo policy: sets when null, preserves manual upload on refresh, updates stale bundle URL, direct-import mirror still budget-bound.
- Update/remove stale tests touching the old storage paths. `npm run build` green.

## Rollout order (after PR merge — merge deploys prod)

1. Verify new upload path in prod (photo upload → `assets.careervine.app` URL).
2. Run migration script → spot-check avatars → `--cleanup` pass.
3. Republish bundle via driver (**must pass `--slug apm-data-bundle --name "APM Data Bundle"`** — slug/name revert otherwise) → version bump fans out → verify a subscriber's contacts gained R2 `photo_url`s. Deadline: before ~July 22 licdn expiry.
4. Watch Supabase usage over following days; post egress-flatline confirmation on CAR-35.

No Supabase schema changes → no migration files. No manual steps for Dawson (rules 27–28); the only human gate is the PR merge.

## Risks / notes

- `sharp` on Vercel Node runtime is natively supported (Next.js uses it internally); pin the version.
- R2 custom-domain provisioning takes a minute or two — done in Phase 0, long before anything depends on it.
- During the deploy→migration window, old Supabase URLs keep serving (bucket untouched until `--cleanup`), so there's no user-visible gap.
- Free-plan restriction risk is time-bound anyway: quota resets July 24; this lands well before.

## Out of scope (follow-ups)

- Contacts-page virtualization/pagination (lazy-load makes images a non-issue; revisit if 2,000 DOM rows still feel slow → separate ticket).
- `attachments` + transcript-audio buckets (private, signed, low volume — correctly on Supabase).
- CAR-15 (scrape refresh cadence) — will inherit the new mirror path automatically via `downloadAndStorePhoto`.

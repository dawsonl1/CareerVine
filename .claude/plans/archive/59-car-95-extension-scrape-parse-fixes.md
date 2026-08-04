# CAR-95 — Extension scrape/parse: wrong photo, student misclassified, missing experiences

Branch: `dawson/CAR-95-extension-scrape-parse` (off main). Found by Dawson testing a BYU
student profile (Rob Wallis) through the rebuilt extension.

## Three bugs, one theme

The AI parser and the panel are fine — they process whatever the scraper sends. The
scraper was sending a shallow, collapsed snapshot.

1. **Wrong/missing photo** — `extractProfilePhotoUrl()` grabbed the first
   `profile-displayphoto` CDN image of two hardcoded sizes anywhere in `<main>`, with no
   identity check (so it could pick a "People you may know" avatar) and missed hero photos
   served at other sizes (e.g. 200×200 → returned null).
2. **"Professional" instead of "Student"** — classification is derived purely from the
   education array's `end_year` (`deriveContactStatus`), defaulting to professional when
   education is empty/unparsed. The BYU 2028 entry never reached it because education
   wasn't fully scraped.
3. **1 of 6 experiences** — scraper reads only inline `main.innerText`; on a profile with
   a long activity feed, Experience/Education sit far down and weren't rendered because the
   scroll loop used `behavior: 'smooth'` and exited before the animation/lazy-load caught up.

## Fix — MINIMAL scope (chosen with Dawson): prompt + scroll + photo. No click/nav.

**Scraper** (`chrome-extension/src/content/linkedin-scraper.js`):
- Scroll: `behavior: 'instant'` step-scroll with a settle at the bottom and a safety cap,
  so lower sections actually render before `innerText` is captured.
- Photo: scope to the intro `<section>` (the one holding the name `h1`) first; fall back to
  an alt-text identity match against the person's name; accept any size (normalize to
  400×400); return null rather than risk a stranger's avatar.

**Parser** (`careervine/src/app/api/extension/parse-profile/route.ts`):
- Instructions: extract EVERY role (incl. internships/part-time/past), split multi-role
  companies into one entry per role, and capture all education with the (possibly future)
  expected graduation year.
- Schema: education `maxItems` 2 → 4 so a classification-driving entry can't be dropped.
- Deliberately NOT adding `minItems` to experience (would force fabrication for people with
  no jobs) and NOT adding an AI classification field (keeps the education-derived logic).

## Accepted limitation
Profiles whose lists stay collapsed behind a separate "Show all experiences" page may still
clip. Deeper in-page expansion / `/details/` navigation deferred.

## Verification
- `npm run test` 1269 passing; `npm run build` clean; scraper `node --check` valid.
- Scraper is DOM-dependent → verified in-browser: reload the unpacked prod build and
  re-scrape Rob's profile (photo correct, all 6 experiences, classified Student). The
  photo + scroll fixes are observable against prod parse pre-merge; the prompt hardening
  deploys on merge.

## Post-merge
Extension change ships on the next Chrome Web Store republish (bundle with CAR-80's).
Parser change deploys to prod on merge.

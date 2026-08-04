# CAR-68 — Extension onboarding: seeded home-page to-do + guided LinkedIn import & Apollo email flow

**Authoritative flow:** Dawson's FigJam — [Chrome Extension onboarding flow chart](https://www.figma.com/board/CWLOJ4WTJbM5YTrgHLjN7Q/Chrome-Extension-onboarding-flow-chart). Additive to CAR-50's guided flow: not forced open, just sits in the action list until started or deleted.

All design decisions below were brainstormed and signed off with Dawson 2026-07-11. Code claims verified by three read-only audit agents against the current tree.

## Product flow (from the FigJam)

**Part 1 — CareerVine extension (~3 min):**
1. New accounts see a default to-do: *"Download the LinkedIn scraping Chrome extension to import your first contact."*
2. Click → intro modal → **Start (est. 3 min)** or **delete task** (normal delete, gone forever).
3. Explainer (auto-filling contacts is tedious; the extension does it) → button opens the Chrome Web Store listing in a new tab.
4. "Log in to the Chrome extension" — polls, auto-advances when the extension connects.
5. "Go to LinkedIn, open a profile" + looping demo video; footer: advances after the first contact is added.
6. On tab refocus after import → confetti, "Your career vine has grown a little bigger." After ~4s: *"Want to learn how to find this contact's email address?"* — **Yes** (prominent) / **"No, I want to see my new contact"** → redirect to `/contacts/{id}`, end.

**Part 2 — Apollo (if Yes):** Apollo explainer → install Apollo extension (store link + next) → how-to video → both-together video, auto-advances when a contact **with an email** is saved via the extension → refocus → confetti + alternatives slide-in (Hunter.io, RocketReach, ContactOut). End.

## Schema (one migration)

`supabase/migrations/<ts>_extension_onboarding.sql`:

1. **`users` columns** (CAR-50 precedent — `onboarding_state` lives on `users`; there is no `user_settings` table):
   - `extension_onboarding_state text NOT NULL DEFAULT 'not_started'` + CHECK: `('not_started','started','awaiting_connect','awaiting_first_contact','email_offer','apollo_intro','apollo_install','apollo_howto','awaiting_email_contact','done','completed_no_apollo')`
   - `extension_onboarding_contact_id bigint` (FK contacts, ON DELETE SET NULL) — first imported contact, for the end-of-flow redirect
   - `extension_last_seen_at timestamptz` — stamped on every extension API call
   - Column-level `GRANT UPDATE (extension_onboarding_state, extension_onboarding_contact_id) ON users TO authenticated` (mirrors `20260711003000_user_onboarding_state.sql:24`; forward-only enforcement stays client/server-side like CAR-50). `extension_last_seen_at` is written by the RLS-scoped client in the API wrapper, so include it in the grant.
   - **No backfill** — existing accounts keep `not_started` but never get the seeded row, so the flow never triggers for them (per Dawson: new accounts only, not even his).
2. **Seed the to-do**: `CREATE OR REPLACE FUNCTION public.handle_new_user()` (from `20260214065839_auto_create_user_profile.sql`, the only `AFTER INSERT ON auth.users` trigger) to additionally insert one `public.follow_up_action_items` row: `user_id`, `contact_id NULL`, `source 'onboarding'`, `title` = FigJam copy, `description` = one-liner teaser. SECURITY DEFINER with `search_path=''` — keep schema-qualified names.
3. **Cleanup**: `DROP TABLE user_onboarding;` and `ALTER TABLE email_messages DROP COLUMN is_simulated;` — shipped 2026-03-26 for the abandoned floating-card design; zero code references (verified).

Regenerate `database.types.ts` via `supabase gen types` (never hand-edit).

## Server changes

1. **`api-handler.ts`** (`:118-122`, the single choke point where `extensionAuth: true` resolves the user): fire-and-forget stamp of `users.extension_last_seen_at = now()` — guarded on `config.extensionAuth` **and** the request actually carrying a Bearer header (cookie-auth webapp calls also pass through this branch; `bulk-import`/`target-companies` routes accept extensionAuth but are driven by the web app). Throttle to once per ~60s per request-less heuristic is unnecessary — a single UPDATE per extension call is fine at current volume.
2. **New route `POST /api/extension/ping`** — `withApiHandler({ extensionAuth: true })`, trivial 200 body. Exists purely so the extension can announce itself at login; the wrapper stamp does the actual work.
3. **`/api/contacts/import/route.ts`** — in the post-success block (`:118-127`, next to the existing `!isUpdate` milestone branch), using the in-scope RLS-scoped `supabase`:
   - state `awaiting_connect` or `awaiting_first_contact` → set `awaiting_first_contact`-appropriate advance: any successful import advances to `email_offer` and records `extension_onboarding_contact_id = contact.id` (advance on create **or** update — a brand-new account importing anyone counts as their first contact).
   - state `awaiting_email_contact` **and** the request's `contactInfo.email` present → advance to `done`.
   - Both writes are best-effort (never fail the import).

## Extension changes (ships via Chrome Web Store review — flow tolerates the lag)

- `background.js` `handleAuthentication()` (`:297-299`, after session store, before `sendResponse`): fire `authenticatedPost('/extension/ping')` best-effort.
- Also ping from `checkAuthentication()` (`:314-330`, runs on every popup open) so already-logged-in users stamp last-seen without re-authing.
- Bump manifest version, build via `build-prod.sh`. Store submission is Dawson's (CAR-40 pattern) → manual-steps checklist.
- Until the new build clears review, "connected" detection still works via the wrapper stamp on the user's first extension action (parse-profile fires on any LinkedIn profile visit with the panel).

## Web app changes

**State lib** — `careervine/src/lib/onboarding/extension-state.ts` mirroring `onboarding/state.ts`: `getExtensionOnboardingState`, `advanceExtensionOnboardingState` (forward-only rank; `completed_no_apollo` and `done` both terminal), browser-client reads/writes under the column grant.

**Unified action list** (`unified-action-list.tsx`) — new item type `"onboarding"`:
- `ActionItemType`/`FilterType` unions (`:111`, `:132`), `typeLabels` badge map (`:217`, `Record<ActionItemType,…>` forces it), `counts` (`:362`), `filters` (`:391`).
- Row rendering: rows currently wrap avatar+content in `<Link href="/contacts/{id}">` (`:540`, `:549`) — the onboarding row instead fires an `onStartOnboarding` callback (opens the modal). CareerVine leaf avatar, no snooze, no complete button; delete only (FigJam: start or delete). Non-Chrome browsers: same row + "requires Chrome" hint copy (new tiny `isChromeLike()` util — none exists in the codebase; `navigator.userAgent` check, Chromium family counts since CWS works there).
- Home page `page.tsx`: seeded row arrives through the existing `getHomeCoreData` query (verified: `contacts(*)` embed is a LEFT join at `queries.ts:1818` — NULL-contact rows flow through). Map `source==='onboarding'` items to the new type with high priority (~90, top of a new user's list). Delete = existing `deleteActionItem`.
- **Empty-state interaction**: `isEmpty` (`page.tsx:694`) would flip false once the seeded row exists, hiding `GettingStartedList` (the 5 getting-started cards). Fix: compute `isEmpty` excluding onboarding-source items, and when the list holds *only* the onboarding row, render it above `GettingStartedList`, dropping that list's now-redundant "Install the Chrome extension" card (`unified-action-list.tsx:271-285`). Flagged to Dawson in the PR for a UX look.
- `/action-items` page needs nothing: NULL-contact rows already render as "No contact" gracefully (verified `page.tsx:345`); clicking opens the detail modal there, which is acceptable — the home row is the flow's front door.

**Flow modal** — new `careervine/src/components/onboarding/extension-onboarding-modal.tsx`, mounted in root layout beside `<OnboardingFlow />` (`app/layout.tsx:107`), opened via a small context (mirrors quick-capture pattern). Reuses `ui/modal.tsx` (`Modal`) as the shell; steps keyed off `extension_onboarding_state`:
- Steps per the FigJam with its copy. Store buttons: CareerVine listing `https://chromewebstore.google.com/detail/careervine-linkedin-integ/kckdmkjjfcnjlhilgdgfggpgodlmbacd` (reuse `NEXT_PUBLIC_EXTENSION_STORE_URL`, already consumed by the empty-state card — verify it's set in Vercel), Apollo `https://chromewebstore.google.com/detail/apolloio-free-b2b-phone-n/alhgpfoeiimagjlnfekdhkjlkiomcapa`.
- Waiting steps (`awaiting_connect`, `awaiting_first_contact`, `awaiting_email_contact`): poll the `users` row every ~4s (browser client); `awaiting_connect` advances when `extension_last_seen_at` is fresh (> flow start time). Fast-forward: on Start, if `extension_last_seen_at` already recent → jump to `awaiting_first_contact`.
- Refocus + confetti: `visibilitychange` listener; when returning with an advanced state, show the congrats step. **Extract CAR-50's inline confetti** (`onboarding-flow.tsx:477-518`) into a reusable `<ConfettiBurst>` and use it in both places. 4s slow-then-stop per the board, then the email-offer slide-in (Yes prominent; "No, I want to see my new contact" → mark to-do complete, state `completed_no_apollo`, `router.push` to `/contacts/{extension_onboarding_contact_id}`).
- Terminal `done` step: confetti + congrats + alternatives slide-in (Hunter.io, RocketReach, ContactOut, linked). Mark the to-do row completed (`is_completed`, `completed_at`) when entering either terminal state; no-op if the row was deleted.
- Closing the modal mid-flow is fine — state persists; clicking the to-do reopens at the resume point.

**Videos** — R2 `dawsonsprojects-assets` under `careervine/onboarding/` (`add-to-network.mp4`, `apollo-extract.mp4`, `both-together.mp4`). Build against placeholder clips; swap when Dawson records. Public serving needs a custom domain on the bucket — check whether one exists; if not, attach one via the Cloudflare API (Claude-owned, not a manual step).

**Analytics** (CAR-38 conventions): `extension_onboarding_started`, `_step` (prop: state), `_deleted`, `_completed` (prop: `apollo` boolean).

## Tests (`npm run test` from `careervine/`)

- `extension-state` rank/forward-only transitions (mirror existing onboarding-state tests if present).
- Import-route hook: advances on success at the right states, records contact id, email-gated for `awaiting_email_contact`, never breaks the import on write failure.
- `api-handler` stamp: fires only for Bearer-authenticated extensionAuth requests.
- Unified list: onboarding item renders, click fires callback not navigation, delete works, Chrome hint on non-Chrome UA.
- `isEmpty` recomputation with onboarding-only list.

## Rollout

1. PR (this branch, `dawson/CAR-68-extension-onboarding`); tests green; merge on Dawson's go.
2. On land: `supabase db push --dry-run` → review → `push` (standing authority, rule 27). Verify `NEXT_PUBLIC_EXTENSION_STORE_URL` in Vercel (rule 28); redeploy if env changed.
3. Extension: build + hand Dawson the store-submission step (manual-steps checklist on CAR-68).
4. Manual steps for Dawson: record the three clips; approve CWS submission.
5. Verify with a fresh test signup: row seeded, flow runs end-to-end against the live extension.

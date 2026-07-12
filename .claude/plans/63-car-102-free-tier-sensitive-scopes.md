# Plan 63 — CAR-102: Free tier (sensitive scopes only), gate `gmail.modify` behind an entitlement flag

Part of CAR-101 (free vs paid tier architecture). **Phase 1:** make the app request only sensitive scopes by default and degrade gracefully without `gmail.modify`, so we can complete the free sensitive-scope OAuth verification (no CASA) and lift the 100-user cap for free users.

## Why

Google verifies what the live app *actually requests*. Today every connect requests `gmail.modify` (restricted) → forces CASA. Phase 1 removes `gmail.modify` from the default flow and hides the features that need it behind an entitlement flag (off for everyone for now). After deploy, the production consent screen shows only sensitive scopes, unblocking free verification. The paid tier that re-adds `gmail.modify` is Phase 2 (not in this plan).

## Current state (verified this session)

- Scopes (`src/lib/gmail.ts`): `GMAIL_SCOPES = [gmail.modify, gmail.send]`, `CALENDAR_SCOPES = [calendar, calendar.events]`. Default connect = modify+send; `?scopes=calendar` = modify+send+calendar. **`gmail.modify` is in every flow today.**
- `getAuthUrl(state, includeCalendar)` — `src/app/api/gmail/auth/route.ts` maps `?scopes=calendar`.
- Callback (`.../callback/route.ts:70`) uses `gmail.users.getProfile` (needs a read scope) to learn the email; stores tokens in `gmail_connections`; sets `calendar_scopes_granted` from `tokens.scope`.
- `gmail_connections` columns (from the connection route SELECT): `gmail_address`, `calendar_scopes_granted`, `calendar_*`, `availability_*`, tokens, timestamps. **No entitlement/tier column.**
- Reply-detection lives **only** in the follow-up cron (`send-follow-ups/route.ts:117-160`): `threads.get` → if a reply, cancel sequence (`cancelled_reply`) + `activateContactByEmail` (network graduation).
- Read/modify features (all need `gmail.modify`): inbox (`/api/gmail/inbox` + `app/inbox/page.tsx`), per-contact history (`contact-emails-tab.tsx`, `/api/gmail/emails`, `/sync`), unread badge (`navigation.tsx`, `/unread`), mailbox actions + real Gmail drafts (`gmail.ts` modify/trash/`drafts.create`, `compose-email-context.tsx`), labels (`/labels`).
- Send path (`gmail.ts` `buildMimeMessage`/`sendEmail`): sets In-Reply-To/References only if passed; does **not** set a `Message-ID`. `threadId` used for the user's own mailbox threading.

## Work items (ordered)

### 1. Scope sets → free by default (`src/lib/gmail.ts` + auth route)
- Redefine:
  - `SIGN_IN_SCOPES = [openid, userinfo.email]` (non-sensitive → id_token carries the email, replaces getProfile)
  - `FREE_GMAIL_SCOPES = [gmail.send]`
  - `CALENDAR_SCOPES = [calendar, calendar.events]`
  - `RESTRICTED_GMAIL_SCOPES = [gmail.modify]` — defined but **not requested** in Phase 1 (Phase 2 uses it)
- `getAuthUrl`: default = `SIGN_IN_SCOPES + FREE_GMAIL_SCOPES` (+ `CALENDAR_SCOPES` when calendar). Keep `access_type: offline`, `prompt: consent`.
- Net: no `gmail.modify` in any Phase 1 consent request.

### 2. Learn email from id_token, not getProfile (callback)
- After `getToken(code)`, decode `tokens.id_token` (JWT) → `email` claim; fallback to the userinfo endpoint if absent. Remove the `getProfile` call.
- Keep `calendar_scopes_granted` detection from `tokens.scope`.

### 3. Entitlement flag (migration + plumbing)
- Migration `supabase/migrations/<ts>_gmail_automatic_features_flag.sql` — add to `gmail_connections`:
  - `automatic_features_enabled boolean not null default false` — entitlement; **no backfill** (everyone starts free). Granted per-user via the admin toggle (item 8).
  - `modify_scope_granted boolean not null default false` — **backfill existing rows to true** (all current connections hold `gmail.modify`), so the dashboard knows who can be toggled on without a reconnect. Phase 2 sets it on paid reconnect.
- `/api/gmail/connection` SELECT + `src/hooks/use-gmail-connection.ts`: expose `automaticFeaturesEnabled`.
- Server helper `userHasAutomaticFeatures(userId)` (service client) for API routes + cron.

### 4. Cron branches by tier (`send-follow-ups/route.ts`)
- Build a `Map<userId, boolean>` of automatic-features (mirroring the existing `emailByUser` map).
- Wrap the `threads.get` reply-detection block in `if (automaticByUser.get(userId))`. Free users skip reply-detection entirely and proceed to the scheduled send (respecting manual cancellations). No `threads.get` → no scope error.

### 5. Manual "mark as replied → stop sequence"
- New route `POST /api/gmail/follow-ups/mark-replied` `{ threadId | followUpId }`: set sequence → `cancelled_reply`, pending messages → `cancelled`, call `activateContactByEmail` (identical outcome to auto-detection).
- UI control on the contact page / follow-up UI: "They replied — stop follow-ups" (shown for free users; paid users get it automatically via the cron).

### 6. Gate the read/modify UI + harden the paid routes
- Gate behind `automaticFeaturesEnabled` with an "available on the automatic plan (coming soon)" state instead of a live call:
  - Inbox nav item + `/inbox` page (`navigation.tsx`, `app/inbox/page.tsx`)
  - Per-contact Emails tab (`contact-emails-tab.tsx`)
  - Unread badge (`navigation.tsx`)
  - Real-Gmail-draft path in compose (`compose-email-context.tsx`) → fall back to the app-side draft (already free)
- Defense in depth: paid API routes (`inbox`, `emails`, `sync`, `unread`, `labels`, draft-create, mailbox actions) return a clean `403 { gated: true }` when `!automaticFeaturesEnabled`, so nothing calls a Gmail read without the scope.

### 7. Read-free threading (verify, then self-set Message-ID)
- Verify how follow-ups currently obtain In-Reply-To/References. If they read the sent message for the RFC Message-ID, add a self-generated `Message-ID: <uuid@careervine.app>` in `buildMimeMessage`, store it on the sent email/follow-up record, and pass it as In-Reply-To/References on follow-ups. No mailbox read needed.

### 8. Admin toggle for automatic-features entitlement (management dashboard)
- New per-user admin route `POST /api/admin/users/[id]/automatic-features` (session-gated `requireAdmin: true`), mirroring the existing `ai-policy` / `bundle-access` per-user routes. Flips `gmail_connections.automatic_features_enabled` via the service client.
- Toggle control in the admin users dashboard (`src/app/admin/users/...`), beside the existing per-user admin controls. Surface `modify_scope_granted` so the toggle reads "entitled, awaiting reconnect" when the scope isn't granted yet.
- **This is the Phase 2 paid-grant mechanism** ("$15 in → flip the toggle"), built now rather than later.
- Post-deploy: owner toggles his own 4 accounts on; the 2 external friend accounts (Mark, Weston) stay free like everyone new.

## Tests (Vitest, from `careervine/`)
- Auth URL: default + calendar variants contain send/calendar/openid/email and **not** `gmail.modify`.
- Callback: email derived from id_token; no getProfile.
- Cron: free user → no `threads.get`, sends on schedule; automatic user → reply-detection cancels + activates.
- `mark-replied` route: cancels sequence + activates contact.
- Admin `automatic-features` route: `requireAdmin` gate + flips the flag.
- Update existing gmail/auth + api-schema tests.

## Migration & deploy
- Claude applies the migration after merge (dry-run → `supabase db push`; rule 27).
- Merge → prod deploy → live default consent screen is sensitive-only → verification can be submitted.

## Decisions / risks
- **Only the owner's own accounts get automatic in Phase 1.** Everyone defaults to free, incl. the 2 external friend accounts (Mark, Weston — not target users); the owner flips his own 4 accounts on via the admin toggle (item 8). No hardcoded emails in the migration. Existing modify tokens stay valid, so toggled-on accounts work immediately.
- Keep `RESTRICTED_GMAIL_SCOPES` + `createDraft`/inbox/sync code in place but dormant for Phase 2 — don't delete, just stop requesting/exposing.
- Confirm `openid`/`userinfo.email` are non-sensitive (no verification cost) — expected, verify in Console data-access panel.

## Out of scope (Phase 2+, CAR-101)
Paid entitlement purchase, reconnect/incremental-auth to add `gmail.modify`, Venmo/Stripe, CASA submission.

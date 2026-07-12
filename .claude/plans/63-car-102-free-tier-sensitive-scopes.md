# Plan 63 — CAR-102: Free tier (sensitive scopes only), gate `gmail.modify` behind an entitlement flag

Part of CAR-101. **Phase 1:** default to sensitive scopes only, gate everything that needs `gmail.modify` behind an entitlement flag, so we can complete the free sensitive-scope OAuth verification (no CASA) and lift the 100-user cap for free users.

> **v2 — audit-corrected (2026-07-12).** A 4-agent read-only audit confirmed the core architecture but caught: (1) item 7's premise was false — the follow-up send path is already read-free; (2) the cron gate must key on scope-granted, not entitlement alone, or it 403s the exact error we're avoiding; (3) three `gmail.modify` callers were missing from the gating list — MCP `create_email_draft`, the Settings "Sync now" button, and the `emails/[id]` detail route; (4) two features die silently for free users — the `reply_received` north-star and bounce auto-cancel; (5) a CAR-27 column-grant collision if the flag is read via the browser client. All folded in below.

## Why
Google verifies what the live app *actually requests*. Today every connect requests `gmail.modify` (restricted) → forces CASA. Phase 1 removes it from the default flow and hides the features that need it behind an entitlement flag (off by default). After deploy the production consent screen shows only sensitive scopes, unblocking free verification. The paid tier that re-adds `gmail.modify` is Phase 2.

## Current state (verified)
- Scopes (`src/lib/gmail.ts:28`): `GMAIL_SCOPES=[gmail.modify, gmail.send]`, `CALENDAR_SCOPES=[calendar, calendar.events]`. `getAuthUrl` (`gmail.ts:42`) is the ONLY consent-URL generator; its one caller is `api/gmail/auth/route.ts:35`. `gmail.modify` is in every current flow. Token refresh does not re-specify scopes. **`careervine-mcp/` and the chrome-extension use Supabase auth, no Google OAuth** — no scope changes needed there.
- **Reply/bounce reads live in THREE places, not one:** (a) cron `threads.get` (`send-follow-ups/route.ts:120`) gates follow-up sends; (b) `syncEmailsForContact` (`gmail.ts:122-159`) graduates prospect/bench→active on inbound AND fires the `reply_received` north-star event (`gmail.ts:278`); (c) `detectBounces` (`gmail.ts:900`, only in `/api/gmail/sync`) cancels sequences on bounce. `checkForReplyInThread` (`gmail.ts:626`) is dead code. All need `gmail.modify`.
- **The send / follow-up path is ALREADY read-free:** `threadId` + `original_gmail_message_id` both come from the `messages.send` response; `sendTrackedEmail` cap/bounce-refusal/cache/log are all DB (`email-send.ts`). Dropping `gmail.modify` does NOT break sending or follow-up scheduling.
- **In-app MCP tools** (`src/mcp/tools/email.ts`, exposed via remote `/api/mcp` + local stdio through shared `registerAllTools`): `create_email_draft` → `drafts.create` needs modify and is NOT try/catch wrapped (hard error for free). Read helpers (`get_email_thread`, `resolveReplyHeaders`) are try/catch → degrade.
- Cache/DB-only, already free-safe: `/api/gmail/inbox`, `/unread`, `/drafts` (app-side `email_drafts`, NOT Gmail), `/emails/[id]/hide`, `/schedule/process`, `send-scheduled-emails` cron. Compose has **no** real-Gmail-draft path.
- `gmail_connections`: 17 columns, no entitlement column. CAR-27 locked it to **column-grants** — the browser/`authenticated` client can read only `(id, user_id, gmail_address, last_gmail_sync_at, created_at)`; everything else is service-role only.

## Work items

### 1. Scope sets → free by default (`src/lib/gmail.ts` only; auth route unchanged)
- `SIGN_IN_SCOPES=[openid, userinfo.email]` (non-sensitive → id_token carries the email), `FREE_GMAIL_SCOPES=[gmail.send]`, `CALENDAR_SCOPES=[calendar, calendar.events]`, `RESTRICTED_GMAIL_SCOPES=[gmail.modify]` (defined, NOT requested in Phase 1).
- `getAuthUrl` default = `SIGN_IN_SCOPES + FREE_GMAIL_SCOPES` (+calendar when calendar); keep signature + `access_type: offline` + `prompt: consent`. No `gmail.modify` in any Phase 1 consent.

### 2. Email from id_token + persist `modify_scope_granted` (callback)
- Replace `getProfile`: derive the email via `oauth2Client.verifyIdToken()` (fallback userinfo endpoint), lowercase before storing (matching/`From` correctness).
- **Persist `modify_scope_granted`** from `tokens.scope` on EVERY upsert, mirroring `calendar_scopes_granted` (`callback/route.ts:61,81`): `grantedScopes.some(s => s.includes("gmail.modify"))` — keeps the flag truthful after any reconnect.

### 3. Entitlement flag (migration + plumbing)
- Migration: `ADD COLUMN automatic_features_enabled boolean NOT NULL DEFAULT false;` and `ADD COLUMN modify_scope_granted boolean NOT NULL DEFAULT true; ALTER COLUMN modify_scope_granted SET DEFAULT false;` (existing rows → true since all current connections hold modify; future → false).
- **No GRANT change** — the new columns stay invisible to the browser client under CAR-27's column-grants; exposed ONLY via the service-role `/api/gmail/connection` route + `use-gmail-connection.ts` hook. **Do NOT** add the flag to `queries.ts` `getGmailConnection` (browser client) — untyped clients would throw "permission denied for column" at runtime.
- Server helper `userHasAutomaticFeatures(userId)` (service client); missing row → false.
- Regenerate `database.types.ts`.

### 4. Cron branches by tier (`send-follow-ups/route.ts`)
- Add `automatic_features_enabled` + `modify_scope_granted` to the EXISTING `gmail_connections` pre-fetch (`route.ts:76-79`) — no second query. `automaticByUser` = both true.
- Gate the `threads.get` block on `automatic_features_enabled && modify_scope_granted` (NOT entitlement alone — an entitled-but-scope-less user would 403). Free users skip it and send on schedule.

### 5. Manual "stop follow-ups" control (replaces auto-cancel for free)
- New route `POST /api/gmail/follow-ups/stop` `{ followUpId|threadId, reason: replied|bounced|manual }`: sequence → `cancelled_reply` (replied) / `cancelled_user` (bounced|manual), pending → `cancelled`; on `replied` also `activateContactByEmail` + fire `reply_received` (mirror `gmail.ts:278`) so the north-star survives the free tier.
- Covers BOTH the reply gap and the **bounce gap** (free users have no `detectBounces`): user sees the reply/bounce in their own Gmail and stops the sequence. UI control on the contact/follow-up surface.

### 6. Gate the read/modify surfaces (web + MCP)
**Hard-error surfaces (MUST gate — would 403 free users):**
- **MCP `create_email_draft`** (`src/mcp/tools/email.ts:114`) — gate on `userHasAutomaticFeatures`; fall back to an app-side `email_drafts` insert or a clear "automatic plan" message. One fix covers remote + stdio.
- **Settings "Sync now"** (`integrations-section.tsx:161`) — gate/hide.
- **Per-message routes** `/api/gmail/emails/[messageId]` (detail/getFullMessage), `.../read`, `.../move`, `.../trash` (POST+DELETE), and **`/api/gmail/sync`** (guards `syncEmailsForContact` + `detectBounces`) — return `403 {gated:true}` at entry when not entitled.
- Update MCP consent copy `oauth/consent/page.tsx:157` (drop "Create Gmail drafts" for free).

**UI gating (product choice; cache-safe but hide for coherence):** Inbox nav + `/inbox`, contact Emails tab, unread badge. (`/inbox`, `/unread`, `/drafts`, `/emails/[id]/hide` are DB-only — no correctness risk; gating is cosmetic.)

### 7. DEFERRED out of Phase 1 → own ticket: recipient-side threading
- Audit correction: follow-up sends are ALREADY read-free, so removing `gmail.modify` does NOT break threading — item 7 is NOT required here. Separately, recipient-side threading is pre-existingly broken (`In-Reply-To`/`References` carry a Gmail API id, not an RFC `Message-ID`). If fixed later: add a NEW `rfc_message_id` column (never overwrite `original_gmail_message_id`, keyed on the API id for dedup), self-set `Message-ID` in `buildMimeMessage`, reuse on follow-ups + MCP reply headers.

### 8. Admin toggle (management dashboard)
- Mirror **`scrape-controls`** (boolean + `Toggle` component), NOT ai-policy. Route `PATCH /api/admin/users/[id]/automatic-features`, `requireAdmin: true`, service client. **Verify a `gmail_connections` row exists** (else 404 "no Gmail connection"); `.update({automatic_features_enabled}, {count:"exact"})` + count check (silent 0-row is a false success); `writeAudit({action:"set_automatic_features"})`.
- Detail plumbing: add `automaticFeaturesEnabled` + `modifyScopeGranted` to `AdminUserDetail` (`admin-users.ts:43`) + `shapeAdminUser` + a `gmail_connections` query in the detail GET route (`api/admin/users/[id]/route.ts:30-55`).
- New `<AutomaticFeaturesSection>` in the detail page, 3 states: on / "entitled, awaiting reconnect" (`enabled && !modify_scope_granted`) / disabled "no Gmail connected" (no row).
- **This is the Phase 2 paid-grant mechanism.** Post-deploy: owner toggles his own 4 accounts on; Mark + Weston stay free like everyone new.

## Tests (Vitest, from `careervine/`)
- Auth URL: default + calendar contain send/calendar/openid/email, NOT `gmail.modify`.
- Callback: email from id_token; `modify_scope_granted` persisted from scope.
- Cron: free (no scope) → no `threads.get`, sends on schedule; automatic (both flags) → reply-detection cancels + activates.
- `/follow-ups/stop` route: each reason cancels correctly; `replied` fires `reply_received` + activates.
- MCP `create_email_draft`: gated for non-entitled.
- Admin route: `requireAdmin` gate + row-exists + count check + audit.
- Update existing gmail/auth + api-schema tests.

## What free users lose (document; rule 34 — update `public/docs/index.html` if user-visible)
In-app inbox/history, unread badge, mailbox actions, MCP real drafts; auto reply-detection → manual "stop follow-ups"; auto bounce-cancel → manual stop (deliverability caveat: free sequences keep sending until stopped); auto-graduation on non-sequence replies.

## Migration & deploy
Claude applies the migration after merge (dry-run → `supabase db push`; rule 27). Merge → prod deploy → live default consent screen is sensitive-only → verification can be submitted.

## Decisions / risks
- **Only the owner's own accounts get automatic in Phase 1.** Everyone defaults free (incl. friend accounts Mark, Weston); owner flips his 4 via the admin toggle. No hardcoded emails.
- **Bounce handling for free tier = manual** (folded into item 5's stop control). Residual: free sequences keep sending to a bounced address until the user stops them. Accepted for Phase 1.
- Fix stale docstring `email-send.ts:5-9` (follow-ups DO count against the cap now). Leave `checkForReplyInThread` dormant.

## Out of scope (Phase 2+, CAR-101)
Paid purchase, reconnect/incremental-auth to add `gmail.modify`, Venmo/Stripe, CASA. Recipient-threading fix (item 7) is its own ticket.

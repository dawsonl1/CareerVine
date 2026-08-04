# Plan 63 — CAR-102: Free "Outreach" tier (sensitive scopes only) on the CAR-103 capability layer

Phase 1 of CAR-101. Ship a **complete, positive free experience** ("Outreach") for users who grant only sensitive Google scopes (`gmail.send` + calendar, no restricted `gmail.modify`), built entirely on data the app already owns. This lets us submit the free sensitive-scope OAuth verification (no CASA, no 100-user cap) while the paid Inbox (which re-adds `gmail.modify`) is untouched and selected at the capability branch.

> **v3 — Outreach vision + CAR-103 wiring (2026-07-12).** Rewritten after a fresh 4-agent read-only audit of the merged CAR-103 layer. Changes from v2: (1) reframed from "what free users LOSE" to "the Outreach portal free users GET"; (2) wired onto CAR-103 primitives that already shipped — `outreach:portal` capability, `EmailExperience` shell branch, the `OutreachShell` stub, `requireCapability`, the admin automatic-features toggle, and the entitlement columns; (3) **corrected the send-gating premise** — free users CAN send (`gmail.send`), so send routes stay ungated and only live-mailbox READ/MODIFY is paid; (4) **the tier split lives at the client shell, not on `/api/gmail/inbox`** (that route is DB-only); (5) added the `outreach:portal` grant mechanism (a `hasConnection` signal), the `invalid_grant` row-deletion edge case, the `/outreach` naming collision, and the tier-aware badge. Phased into A–E so every piece dark-ships with zero behavior change until the final scope flip.

> **v4 — audit corrections (2026-07-12).** A 3-agent read-only adversarial audit pressure-tested v3 against the code. Folded in: **(1, critical)** premium users would be silently down-scoped to free by the "Connect Calendar" / reconnect buttons in Phase E → scope set now keys on current premium state, not a variant flag; **(2)** do NOT gate `/api/gmail/emails?contactId=` (would empty free per-contact history) → in-handler skip of the background sync instead; **(3)** the free cron branch must `continue` before the Gmail fetch AND the completion-count, and batch caps into the existing connection pre-fetch; **(4)** `awaiting_review` needs explicit chip arms, count inclusion, and cancel-orphan handling across ~10 sites; **(5)** named-constraint drop/re-add, `inbox` route `conn?.gmail_address` NPE guard, `database.types.ts` Insert-Omit, `resolve.ts` `premium_enabled ?? true` fail-open, MCP `has()` (no server `can()` helper), `get_email_thread` snippet-only. Confirmed safe: free send, gate-list completeness, column-lock, capability-map consistency. Over-scoped in v3 and relaxed: create/schedule reply-header risk (already try/catch-degraded).

---

## The idea in one paragraph

Google verifies what the live app *actually requests* at consent. Today every connect requests `gmail.modify` (restricted) → forces CASA (~$540/yr) and a 100-user cap. Phase 1 makes the default connect request only **sensitive** scopes (`gmail.send`, optionally calendar) and gives those users a self-contained **Outreach portal**: everything they've sent, scheduled, and queued as follow-ups, an "awaiting reply" view, and a **confirm-to-send** follow-up flow (because a free user's mailbox can't be read to auto-detect replies, they confirm each follow-up, which doubles as the reply check). The paid tier re-adds `gmail.modify` for the live Inbox and automatic reply-detection. Which experience a user sees is decided at one place — the CAR-103 `EmailExperience` shell branch — keyed on the `outreach:portal` capability.

---

## What CAR-103 already delivered (do NOT rebuild)

The capability layer is merged to `main`. CAR-102 plugs into it; several v2 work items are already done:

- **Entitlement columns** on `gmail_connections`: `automatic_features_enabled boolean NOT NULL DEFAULT false`, `modify_scope_granted boolean NOT NULL DEFAULT true` (migration `20260712020000_gmail_entitlement_columns.sql`; the `SET DEFAULT false` flip was deliberately deferred to CAR-102). Service-role-only under CAR-27's column-lock.
- **Capability model** — `src/lib/capabilities/{types,map,resolve,index}.ts`. `capabilitiesFor(flags)` is THE single source of truth; `resolveCapabilities(userId)` reads the flags service-side and fails closed to the empty set.
- **`outreach:portal` capability** exists in the vocabulary, granted to NOBODY in Phase 0 (every current user is premium or unconnected).
- **Server gate** — `requireCapability?: Capability` on `withApiHandler` (403 `{error:"Forbidden", capability}`, fail-closed). Applied to ZERO routes so far.
- **Client** — `GET /api/capabilities`, the `use-capabilities` store/hook, `<Capable>`, and the `EmailExperience` shell branch (`can("outreach:portal") ? <OutreachShell/> : <InboxShell/>`, defaults to Inbox).
- **`OutreachShell` stub** — `src/components/email/outreach/outreach-shell.tsx` (19-line placeholder; CAR-102 fills it).
- **Admin automatic-features toggle** — `PATCH /api/admin/users/[id]/automatic-features` + `<AutomaticFeaturesSection>` + `AdminUserDetail` plumbing. This is the Phase-2 paid-grant mechanism and the owner-account switch; **it is already built and deployed.**

---

## Architecture: where the tier split lives

Three (and only three) seams, in priority order:

1. **The client shell branch (already built).** `EmailExperience` picks `OutreachShell` vs `InboxShell` on `outreach:portal`. This is the primary UX divergence. Both shells read the same DB-only data route.
2. **Scope-requiring API routes.** Routes that hit the *live* Gmail mailbox get `requireCapability`. DB-only routes stay ungated — the free portal needs them, and reading your own DB rows requires no scope.
3. **The two send crons + the MCP tools.** Not `withApiHandler` routes, so they branch internally on a per-user capability check (`followups:auto` for auto-send; else confirm-to-send / app-side).

**Corollary — the send path is free.** `sendTrackedEmail` uses `messages.send` (the `gmail.send` scope free users hold), NOT `gmail.modify`. So `/api/gmail/send`, scheduled one-off sends, and the send-scheduled-emails cron all work for free users and MUST NOT be gated as paid. Only *reading* and *modifying* the live mailbox is paid.

---

## Corrections carried from the audit (build these in)

- **Callback derives email from `getProfile` today, not `id_token`** (`gmail/callback/route.ts:68-71`). Switch to `id_token` (the free flow won't request a profile-read scope) and persist `modify_scope_granted` from `tokens.scope`, mirroring the existing `calendar_scopes_granted` line (`:61-62`).
- **`invalid_grant` deletes the connection row** (`oauth-helpers.ts:104`). A down-scoped free user whose refresh token revokes loses their row → reverts to "unconnected" (empty caps, no `outreach:portal`). The portal and badge must tolerate the unconnected state gracefully (prompt to reconnect), and the grant must be row-presence-based so a reconnect restores it.
- **No down-scoping mechanism exists.** Every current row has `modify_scope_granted=true` from the column DEFAULT, not from a recorded grant. Existing accounts stay premium after the flip unless explicitly changed (see Open Decision 1).
- **Naming collision.** There is a legacy `/outreach` page (`src/app/outreach/page.tsx`, the plan-25 company-stepping flow) unrelated to this tier. The free tier's portal lives at `/inbox` via the shell branch and is the `OutreachShell` component / `outreach:portal` capability. Do not route the new portal to `/outreach`; keep the names distinct in code and copy ("Outreach portal" = the free email home, not the company stepper).
- **Confirm-to-send only for follow-ups.** Scheduled one-off sends still auto-send for free users (no reply-dependency). Only follow-ups flip to "awaiting review," because a follow-up must not fire at someone who already replied and free users can't auto-detect that.

---

## Build order (hard constraint) & prerequisites

From the ticket: entitlement columns → admin toggle + **owner's accounts switched `automatic=on`** → **only then** flip the scopes. Columns and toggle are done. So before the scope-flip step (Phase E):

- **Turn on the owner's accounts** via the deployed admin toggle (or the admin API directly). If we flip scopes first, those accounts strand on the free tier with no automatic features and no in-app way back (until reconnect).
- Everything in Phases A–D **dark-ships**: no existing user has `outreach:portal` (all are premium), so the shell branch, the gated routes, the portal, and the cron branch are all inert for current users. Only Phase E (the scope flip) creates the first free users.

---

## Phased implementation

Each phase is an independently shippable PR. A–D change nothing for existing (premium) users; E is the switch that unblocks verification.

### Phase A — Grant wiring + premium admin toggle + paid-route gating (dark; hardening)

**The premium flag (Decision 1, resolved).** Premium = a *fact* (`modify_scope_granted`, callback-set, must stay truthful about the token) AND an *admin entitlement* (a new `premium_enabled` flag). An admin flips a user to free by turning `premium_enabled` off — a pure DB change, no reconnect, token and `modify_scope_granted` untouched. This mirrors the existing automatic-features flag exactly and never lets an admin decision corrupt the token-fact column.

- **Migration:** `ADD COLUMN premium_enabled boolean NOT NULL DEFAULT true` on `gmail_connections` (existing rows → premium stays on; new free connects are gated by `modify_scope_granted=false` regardless, so the true default is safe). Service-role-only under CAR-27's column-lock.
- **Migration (automatic follow-ups default ON for premium):** CAR-103 shipped `automatic_features_enabled NOT NULL DEFAULT false`; flip it: `ALTER COLUMN automatic_features_enabled SET DEFAULT true` + `UPDATE gmail_connections SET automatic_features_enabled = true` (backfill existing rows). Premium accounts now get automatic follow-ups out of the box; the admin toggle becomes an **opt-out**. Safe for free users — `followups:auto` still requires `isPremium`, so a default-true flag grants them nothing. This removes the pre-merge owner-account switch-on chore and makes the deploy a true no-op for existing premium users. (Audit note: the backfill `UPDATE` is unconditional and would overwrite a deliberate admin opt-out back to on — moot today because the cron never consulted the flag yet and no opt-out has ever been set, but if any exists at build time, scope the UPDATE to rows created before the CAR-103 deploy.)
- **`types.ts` `EntitlementFlags`:** add `premiumEnabled: boolean` and `hasConnection: boolean`.
- **`resolve.ts`:** select `premium_enabled` too; pass `premiumEnabled = data.premium_enabled ?? true` (fail-OPEN to premium — a null must never silently down-tier a premium user; the unconnected case is already the early return) and `hasConnection = !!data` into `capabilitiesFor`. Keep the "no row → empty set" early return (unconnected users get nothing).
- **`database.types.ts` (hand-add, BOTH edits, mirroring CAR-103):** add `premium_enabled: boolean` to the `gmail_connections` `Row`, AND add `"premium_enabled"` to the `Insert` `Omit<…>` list (CAR-103 did this at `database.types.ts:481`). Skipping the Omit makes `premium_enabled` a required insert field and breaks every typed gmail_connections upsert at compile time.
- **`map.ts` `capabilitiesFor` — the one-function edit:**
  ```
  const isPremium = modifyScopeGranted && premiumEnabled;
  if (isPremium)                       → mailbox:read, mailbox:modify, drafts:gmail, inbox:premium
  if (automaticFeaturesEnabled && isPremium) → followups:auto
  if (hasConnection && !isPremium)     → outreach:portal
  ```
  So a friend flipped down (`modify_scope_granted=true`, `premium_enabled=false`) is not premium → gets `outreach:portal` → sees the free portal, with no reconnect.

**Premium admin toggle (satisfies Decision 1's request).** Clone the shipped `<AutomaticFeaturesSection>` + `PATCH /api/admin/users/[id]/automatic-features` pattern for a `premium_enabled` control: `PATCH /api/admin/users/[id]/premium`, `requireAdmin`, service client, row-exists/`{count:"exact"}` check, `writeAudit({action:"set_premium"})`. Add `premiumEnabled` to `AdminUserDetail` + `shapeAdminUser` + the detail GET route, and render a master **"Premium (Inbox)"** toggle above the existing automatic-follow-ups sub-toggle in the admin user detail page.

**Apply `requireCapability` to the live-mailbox routes only** (`mailbox:read` unless noted):

**Apply `requireCapability` to the live-mailbox routes only** (`mailbox:read` unless noted):
- `GET /api/gmail/emails/[messageId]` (full-body live get) — `mailbox:read`
- `GET /api/gmail/labels` (live labels) — `mailbox:read`
- `POST /api/gmail/sync` (per-contact live sync + `detectBounces`) — `mailbox:read`
- `POST /api/gmail/emails/[messageId]/read` — `mailbox:modify`
- `POST` + `DELETE /api/gmail/emails/[messageId]/trash` — `mailbox:modify`
- `POST /api/gmail/emails/[messageId]/move` — `mailbox:modify`

**⚠️ Do NOT gate `GET /api/gmail/emails?contactId=` (audit fix).** `requireCapability` rejects before the handler runs, so gating it would return an empty per-contact Sent tab for every free user (Phase B needs this route). The route is 95% DB — `getConnection`, `backfillEmailsForContact`, and the returned `email_messages` read are all DB-only; the ONLY live call is a fire-and-forget `syncEmailsForContact` gated behind `isStale` (`emails/route.ts:47-54`). Fix: leave the route ungated and move a tier check INSIDE the handler that skips only that background `syncEmailsForContact` for users without `mailbox:read`. Same pattern applies to `contacts/[id]/page.tsx:164`'s `schedule/process` fire (already free-safe — send-only).

**Leave ungated (DB-only or scope-free):** `/api/gmail/inbox`, `/emails?contactId=` (see above), `/unread`, `/drafts` (app `email_drafts`), `/schedule`, `/follow-ups`, `/emails/[id]/hide`, `/send`, `/schedule/process`, and the OAuth lifecycle routes (`auth`/`callback`/`connection`/`disconnect`). Their existing `getConnection` 400 ("Gmail not connected") stays — that guards "no Gmail at all," orthogonal to tier. Note: the create/schedule paths (`POST /api/gmail/schedule`, `POST /api/gmail/follow-ups`, MCP `schedule_email`/`create_follow_up_sequence`) need NO gating — they're DB inserts; the only live touch is `resolveReplyHeaders` in the MCP send/schedule tools, which is already try/catch-degraded to `{}` (free users just lose best-effort recipient-side threading headers, the existing contract).

**Tests:** `capabilitiesFor` grants `outreach:portal` iff `hasConnection && !modify`; premium user unaffected; each gated route 403s a free (no-`mailbox:read`) user and passes a premium user; DB-only routes remain reachable for free.

### Phase B — The Outreach portal (dark; fills the stub)

- **Data source:** reuse the DB-only `/api/gmail/inbox` payload (already assembles `email_messages` sent, `scheduled_emails`, `email_follow_ups`, `contactMap`, calendar; confirmed 100% DB, no live Gmail, no premium-only leak). Relax its `getConnection`-null `throw` (`inbox/route.ts:13-16`) so a connected free user renders. **⚠️ Audit fix:** the route ends with `gmailAddress: conn.gmail_address` (`:107`) — relaxing the throw makes a truly-unconnected request NPE→500 there. Guard the return as `conn?.gmail_address ?? null` and have `OutreachShell` tolerate a null `gmailAddress` (show the connect prompt). A genuinely unconnected user gets the connect prompt, not a 500.
- **`OutreachShell`:** build the real portal from that payload — Sent history, Scheduled, Follow-ups (with status), an **"Awaiting reply"** view, and reminders. Drop the live-only surfaces (body-expand, labels, sync, trash/read/move). Reuse `buildThreads`, the follow-up/scheduled chips, and `useCompose` for composing/sending (send is free). Keep copy free of em dashes (rule 35) and the tier framing positive (rule 5) — this introduces the app's first free-vs-paid UI language, so make it feel like a first-class product, not a downgrade.
- **Per-contact sent history + "mark replied" (item 7):** in `contact-emails-tab.tsx`, add a manual **"Mark as replied"** control (the `cancelled_reply` chip footer / thread action row are the natural homes). It flips the sequence to `cancelled_reply`, pending messages to `cancelled`, calls the existing `activateContactByEmail`, and fires the `reply_received` analytics event — preserving the north-star metric the free tier would otherwise lose. Optionally write a synthetic inbound `email_messages` row (mirror the `is_simulated` pattern) so the thread shows the reply.
- **Preview:** temporarily grant yourself `outreach:portal` locally to visually verify (high-risk UI → browser-verify per rule 13).

**Tests:** portal renders sent/scheduled/follow-ups from a mocked payload; "mark replied" flips statuses + activates + fires the event.

### Phase C — Confirm-to-send follow-ups + tier-aware badge (dark cron branch)

- **New status (named-constraint drop/re-add):** the CHECK is the named constraint `email_follow_up_messages_status_check` (`20260325000000_intro_email_flow.sql:13-16`). The migration must `DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check` then re-`ADD` it with `('pending','sending','sent','cancelled','awaiting_review')` — you can't add to a CHECK in place. Add `AwaitingReview: "awaiting_review"` to `FollowUpMessageStatus` in `src/lib/constants.ts` (a const map, purely additive; `database.types.ts` types the column as plain `string`, so no regen).
- **`send-follow-ups` cron branch (audit-corrected placement + batching):** fold the entitlement columns into the EXISTING connections pre-fetch (`route.ts:76-80` already selects `user_id, gmail_address` for the active users) — add `modify_scope_granted, automatic_features_enabled, premium_enabled` and build a `capsByUser` map via `capabilitiesFor(...)` right after (zero extra round-trips vs N `resolveCapabilities` calls). The branch must sit **after** `userId`/`threadId` are read (`route.ts:86-88`) and **before** the Gmail client fetch (`route.ts:93`): for a user lacking `followups:auto`, flip that sequence's due `pending` messages → `awaiting_review` and **`continue`**. This placement is load-bearing twice over — (a) if it fell through to `getGmailClient`+`threads.get` (`:120`, needs a read scope) it would throw→`continue` and free follow-ups would skip **forever, never surfaced**; (b) it must precede the "sequence complete?" count at `:219-223` (which counts only `pending`/`sending`), or a sequence whose last message just became `awaiting_review` gets wrongly marked `completed`, orphaning it. Keep the suspension filter and the Gmail-disconnected 3-day cancel for premium.
- **Confirm route:** `POST /api/gmail/follow-ups/confirm` `{ messageId, replied: boolean }`. `replied=true` → cancel the sequence (`cancelled_reply` + pending → `cancelled`), `activateContactByEmail`, fire `reply_received`. `replied=false` → `sendTrackedEmail` (free-safe) and mark `sent`. This is the manual reply-check folded into the confirm. Must tolerate a parent already `cancelled` (see the cancel-orphan fix below).
- **`awaiting_review` UI + count handling (audit — silent-wrong otherwise):**
  - **Chip rendering:** add an explicit `awaiting_review` arm to the status ternaries in `inbox-shell.tsx:1490-1494` AND `contact-emails-tab.tsx:437-447` (the latter is shown to free users) — today it falls to the else branch and renders a tertiary chip with **no label**. Label it e.g. "Awaiting your review."
  - **"Scheduled" counts:** decide inclusion at the 6+ aggregation sites that currently count only `pending` (`inbox-shell.tsx:566,797,1421,1466`; `contact-emails-tab.tsx:238,427`; `follow-up-modal.tsx:104`; `mcp/lib/db.ts:915`) — an `awaiting_review` message should still count as an open/scheduled follow-up, so include it (or these under-report).
  - **Cancel-orphan:** user-cancel queries filter `.eq(status, 'pending')` (`email-follow-ups/[id]/route.ts:30`, `gmail/schedule/[id]/route.ts:93`, `gmail/follow-ups/[id]/route.ts:44,114`) → an `awaiting_review` message survives a parent cancel, orphaned. Make these also match `awaiting_review` (or guarantee the confirm route tolerates a cancelled parent). Prefer widening the cancel filters.
- **Tier-aware badge:** the nav badge count comes from `useCompose().unreadCount` → `/api/gmail/unread`. **Correction:** that route is DB-only and ungated; for a free user it simply returns 0 (no inbound rows are ever synced), so the badge is empty, not "premium-only." Substitute the **"follow-ups awaiting review"** count for free users: branch in `compose-email-context.tsx` (the provider mounts for all users under `AuthProvider`; `useCapabilities` is `useSyncExternalStore`-safe, no SSR hazard) so `unreadCount` (its only consumer is `navigation.tsx:26,94-96`) becomes tier-correct; source the free count from a small `awaiting_review` count query. Adjust the badge label/tooltip.
- **MCP adaptation (item 8):** the MCP layer has no `withApiHandler` and no server-side `can()` helper — gate with `(await resolveCapabilities(uid())).has(cap)` (both runtimes already stand up the service client via `initDb`; `uid()` is ALS/stdio-populated; no import cycle). Consider a tiny `userCan(userId, cap)` helper (one query per call — acceptable). `create_email_draft` → for a user without `drafts:gmail`, insert an `email_drafts` row (only `user_id` is NOT NULL; all needed fields are already assembled; linkage is name-only, no `contact_id` on that table) instead of `gmail.users.drafts.create`. `get_email_thread` → for a user without `mailbox:read`, serve from cached `email_messages` — **note the cache holds snippet only, not body** (`db.ts:832`); relabel the free response as snippet-level and, for the user's own outbound messages, prefer surfacing stored `body_html` from `scheduled_emails`/`email_drafts` where a local copy exists. Keep send/schedule/follow-up/search tools as-is (send is free). Update the MCP OAuth consent copy to match.

**Tests:** free user's due follow-up → `awaiting_review`, no send, no live read, sequence NOT marked completed; premium → auto-send + reply-cancel path intact; confirm route both branches (incl. cancelled-parent tolerance); a cancel with an `awaiting_review` message present leaves no orphan; `awaiting_review` chip renders labeled and counts as scheduled; badge count is tier-correct; MCP `create_email_draft` writes an app draft for free and a Gmail draft for premium.

### Phase D — Nudges + expiry (item 5) — SPLIT OUT to CAR-105 (Decision 2, resolved)

**Split to its own ticket, CAR-105** (child of CAR-101, sibling to CAR-102, depends on CAR-102). The free tier is fully functional without it — awaiting-review follow-ups simply persist until the user acts. The nudge/expiry engagement layer (up to 2 email nudges, an "expires in X days" countdown, 14-day-if-active vs 24h-after-next-visit expiry, new tracking for user last-active + per-follow-up nudge count + pending-since) is the fuzziest, largest-surface item, touches new columns + a nudge cron + email templates, and does not block verification. It gets its own design pass. **CAR-102 ships A → B → C → E.**

### Phase E — The scope flip (the verification-unblocking switch)

This is the runtime switch. Because CAR-102 ships as **one PR** (Decision 3), A–E all land in the same deploy; the flip is safe because at deploy instant every existing user still has `modify_scope_granted=true` + `premium_enabled=true` → premium, unaffected, while new connects are free. Order matters at RUNTIME, not merge time.

- **No pre-merge chore.** Phase A's migration flips `automatic_features_enabled` to default-on and backfills existing rows, so every current premium account keeps auto-sending follow-ups seamlessly on deploy. Nothing for the owner to toggle beforehand; both premium flags default on.
- **Scopes (`src/lib/gmail.ts`):** add `SIGN_IN_SCOPES=[openid, userinfo.email]`, `FREE_GMAIL_SCOPES=[gmail.send]`, keep `CALENDAR_SCOPES`, define `RESTRICTED_GMAIL_SCOPES=[gmail.modify]`. `getAuthUrl` default (a NEW connect) = `SIGN_IN_SCOPES + FREE_GMAIL_SCOPES` (+calendar when requested).
- **⚠️ Scope set must key on the user's CURRENT premium state, NOT just a free/paid flag (critical audit fix).** The "Connect Calendar" buttons (`setup-banner.tsx:70`, `integrations-section.tsx:228`, `onboarding-flow.tsx:345`) and every reconnect route through `getAuthUrl`. If that resolves to the free set for an existing premium user, their reconnect/calendar-add re-runs OAuth WITHOUT `gmail.modify` → the callback records `modify_scope_granted=false` → they are **silently downgraded to the free portal** with no admin action. Same trap after an `invalid_grant` row-delete + reconnect. Fix: in `gmail/auth/route.ts`, look up the caller's current entitlement and include `RESTRICTED_GMAIL_SCOPES` when they are already premium (`modify_scope_granted && premium_enabled`), so premium reconnect/calendar-add PRESERVES modify. New/free users get the sensitive-only set. (This is also the seam Phase 2's paid upgrade reuses.)
- **Callback:** derive the email via `verifyIdToken()` on the returned `id_token`, **with a `getProfile`/userinfo fallback** so a missing/invalid `id_token` can never wipe `gmail_address`; lowercase before store. Persist `modify_scope_granted = grantedScopes.some(s => s.includes("gmail.modify"))` on every upsert (this is the truthful token-fact; the admin `premium_enabled` flag is separate and untouched here).
- **Migration:** `ALTER COLUMN modify_scope_granted SET DEFAULT false` (future connects → free; existing rows unchanged).
- **Onboarding (item 10):** the connect step / setup banner / `onboarding-flow.tsx` `ConnectStep` reflect the sensitive-only connect and confirm-to-send; the free connect CTA uses the free-scope variant.
- **Docs (rule 34, no em dashes rule 35):** update `public/docs/index.html` sections **#write**, **#followup** (the "7/14/21" cadence + auto-cancel copy at ~723-728), and the **#start** connect step (~602), plus the overview cards (~495, 503, 528, 535) and the #next checklist (~653) to describe the free Outreach experience and confirm-to-send.
- **Deploy → live consent screen is sensitive-only → submit for verification.**

---

## Decisions (resolved 2026-07-12)

1. **Premium flip-down = a `premium_enabled` admin flag, no data migration, no re-auth.** Existing users keep premium (`premium_enabled` defaults true); the owner flips any user to free from the admin dashboard by turning `premium_enabled` off — a DB change only, the token and `modify_scope_granted` (a truthful token-fact) are untouched, and the user is NOT forced to reconnect. New users start free via the sensitive-only connect (`modify_scope_granted=false`). Premium = `modify_scope_granted && premium_enabled` (see Phase A).
2. **Phase D (nudges/expiry) is split to its own ticket.** CAR-102 ships A → B → C → E.
3. **One PR for all of CAR-102** (A–C + E in one branch/PR), merged on the owner's go-ahead; the scope flip lands with it.
4. **Badge free-count source:** a small dedicated `awaiting_review` count query (keeps `/api/gmail/unread` single-purpose).
5. **Automatic follow-ups default ON for premium.** `automatic_features_enabled` flips to default-true + backfills existing rows, so premium accounts get auto follow-ups out of the box and the admin toggle becomes an opt-out. Eliminates the pre-merge owner-account switch-on and makes the deploy a no-op for existing premium users. (Requested 2026-07-12.)

---

## Migration & deploy

Migrations in the single CAR-102 PR: Phase A — `ADD COLUMN premium_enabled boolean NOT NULL DEFAULT true`, and `ALTER COLUMN automatic_features_enabled SET DEFAULT true` + backfill existing rows to true; Phase C — `awaiting_review` status on `email_follow_up_messages`; Phase E — `ALTER COLUMN modify_scope_granted SET DEFAULT false`. Claude applies them after the PR merges (dry-run → `supabase db push`; rule 27; run from the linked main checkout, not the worktree). The deploy makes the live default consent sensitive-only, unblocking verification submission. Regenerate `database.types.ts` where columns/enums change; hand-add the service-only entitlement columns if the untyped-client path is involved (CAR-27 column-lock). Do the owner-account `automatic_features_enabled` switch-on BEFORE merge (Phase E prereq).

## Out of scope (Phase 2+, CAR-101)

Paid purchase / reconnect-to-add-`gmail.modify`, Stripe/Venmo, CASA submission. Follow-up nudges + expiry are CAR-105. Recipient-side threading is CAR-104. The legacy `/outreach` company-stepper is unrelated and untouched.

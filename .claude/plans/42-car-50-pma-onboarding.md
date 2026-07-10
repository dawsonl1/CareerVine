# PMA New-User Onboarding — Design (CAR-50, with CAR-51 + CAR-52)

**Status:** Design signed off by Dawson 2026-07-10 (brainstorm session). No implementation yet — this plan captures the design and its verified premises. Implementation happens per-ticket in ticket-named worktrees.

**Goal:** Time-to-first-value under one minute for new users, targeting the BYU Product Management Association launch (async arrival via Slack/newsletter link). First value = **a populated, personally relevant target list** — delivered with zero integrations, zero AI, zero extension.

## Why bundle-first (decision record)

Candidate aha moments considered: populated target list (~30s, no dependencies), extension capture magic (install friction + AI gate), AI-drafted outreach (stacks contacts + AI + Gmail), logged-conversation loop (requires a real conversation). **Chosen: populated target list.** PMA students share a nearly identical target list, and the APM Data Bundle (live in prod, daily-refreshed) *is* that list — a structural cheat around the CRM cold-start problem.

Rejected along the way: sample/demo data (strictly worse than real bundle data), Gmail-connect-first (OAuth as first interaction, weak student inboxes), auto-subscribe via cohort link (the explicit "add these" click converts someone else's data into the user's decision), top-5 people picker as beat two (students think in companies, not strangers' names).

## The flow (CAR-50)

1. **Cohort link** `careervine.app/pma` → `?cohort=pma` threaded through signup into `user_metadata` (`auth/page.tsx` already reads `?mode=`; `signUp` in `auth-provider.tsx:85-97` already writes `options.data`). PostHog attribution + PM-track preselect.
2. **Signup, no confirmation gate** (CAR-52) → straight into the app.
3. **`/welcome` reveal** (new route, first login, skippable): headline **"1,400+ BYU alumni in product roles"** → one explicit click subscribes + applies the APM bundle. Reuses `POST /api/bundles/subscribe` + chunked `POST /api/bundles/apply` loop; extract the apply-loop from `data-subscriptions-section.tsx:91-146` into a shared helper. Skip path lands on the reworked checklist.
4. **Company picker**: companies ranked by **BYU-alumni count**, count badges, searchable, logos via `companies.logo_url`. Driven by live in-app records post-apply (`getCompanies`, `company-queries.ts:322`, already returns per-tier counts; supports `minContacts`). Alumni count derived from contact education — BYU LinkedIn schoolId `4035` is an exact-match key. Pick **one** to start ("add more anytime").
5. **Pick = target company** (`addTargetCompany`, `company-queries.ts:1088`) → land on that company's page, alumni sorted first, star a few → Up Next alive. Minute two, zero integrations.
6. **Checklist rework** (`GettingStartedList`, `unified-action-list.tsx`): explore target list ✓ → pick a company ✓ → connect Gmail when ready to reach out → try the LinkedIn extension **while your AI day is live** (make it a real link — today it isn't clickable) → log your first conversation.
7. **PostHog funnel** (CAR-38 registry, `object_verb` past tense): link → signup → bundle added → company picked → first star → Gmail → first send. **Activation: bundle + company pick + ≥1 star in first session.** `bundle_subscribed` / `user_signed_up` already exist.
8. **Bundle consumer polish**: rename/describe `data_bundles` row for consumer eyes (keep slug `apm-data-bundle`; republish must pass `--slug/--name` or they revert).

## AI trial (CAR-51)

24h shared-key access per account, **clock starts at first AI use** (not signup — async users must not burn the trial while away). No verification gate (Dawson's explicit call); mitigation is **per-account caps** via the CAR-41 limiter (`rate-limit.ts` + `withApiHandler.rateLimit`) on all shared-key AI routes, plus accepted leakage. Schema: add `expires_at timestamptz` to `user_ai_access` (NULL = permanent, preserves admin grants); gate in `hasSharedAccess` (`openai.ts:151-173`). Expiry UX: quiet trial note → locked state with BYO-key + **"Request AI access"** exits (request button = engaged-user signal).

## Auth change (CAR-52)

Disable Supabase email confirmations (dashboard-only setting; no config.toml in repo). Fix the `check-email` dead-end in `auth-form.tsx` (route signup success into the app → /welcome). **Regression risk:** duplicate-email detection (CAR-46) relies on the confirmations-on empty-`identities` sentinel — must be reworked. Signup rate-limit floor via Supabase auth limits. "Sign in with Google" filed as future auth story, not launch-blocking.

## Verified premises (audited 2026-07-10, this session)

- **Bundle data** (`people-all.json`): 2,000 records, **1,420 (71%) BYU alumni**, education arrays on all; photos on R2. Alumni is the norm → rank companies by alumni *count*, binary badge is meaningless. Current employers span ~667 companies → picker uses in-app records, not static `companies.json` (99).
- **No prospect flood:** every home attention surface is hard-filtered to `network_status='active'` (`queries.ts:1827`, `generate-suggestions.ts:53`, `queries.ts:1342/1758`); bundle imports land as prospect with null cadence. Prospects DO appear on company pages via `contact_companies` (`bulk-import.ts:555`) — the exact surface this flow lands on. Checklist survives bundle apply (`isNewUser` keys off active contacts, `page.tsx:693`).
- **Discovery does NOT light up on company pick** — weekly cron, admin-gated `users.discovery_enabled` (default OFF), paid. Company page is the immediate payoff; onboarding copy must not promise Discovery.
- **PostHog fully wired** (`analytics/client.tsx`, event registry `analytics/events.ts` with milestone funnel).
- **Rate-limit infra exists** (CAR-41) but keys on authenticated user.id — covers AI-trial caps, not signup.

## Sequencing

CAR-52 (auth) and CAR-51 (trial) are independent of each other; CAR-50's welcome flow wants CAR-52 landed first (signup routes into /welcome) and benefits from CAR-51 (checklist's extension item references the AI day). Suggested order: 52 → 51 → 50, or 52 then 50/51 in parallel worktrees.

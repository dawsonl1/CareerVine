# New-User Onboarding — Design v2 (CAR-50, with CAR-51 + CAR-52)

**Status:** Design v2, 2026-07-10. Supersedes v1 (same day) after Dawson's FigJam flowchart — **"Careervine Onboarding Flow"**, https://www.figma.com/board/RB5TcPVlA7wkBvd9SApgFM/Careervine-Onboarding-Flow — which is the authoritative flow. No implementation yet; work happens per-ticket in ticket-named worktrees.

**Goal:** Guided first session that ends with the user having **sent their first networking email with conditional follow-ups scheduled**. This is the default onboarding for ALL new users (assume BYU PMA member; cohort segmentation deferred until the audience broadens). Activation metric: **first networking email sent during onboarding.**

## v1 → v2 deltas (decision record)

- **Email verification is KEPT** (reverses v1's removal decision / original CAR-52 scope). Dawson's flow invests in it instead: CareerVine-branded verification email + confirm-link auto-login straight into onboarding. Side effect: verified emails largely defuse the fake-account exposure of the CAR-51 trial.
- **Activation deepens** from "≥1 prospect starred" to "first email sent." Enabled without AI by **static merge-field templates** (BYU-alumni + non-alumni cold email variants, 3-email follow-up cadence). The AI trial is no longer load-bearing for onboarding.
- **No /pma cohort link** — this flow is the default for everyone.
- **/welcome route → full-screen modal sequence** at first login (Dawson's flow is modal-driven).
- **Gmail + Calendar connect moved INTO the flow** — offered during the bundle-sync wait (dead time), because the flow's endpoint (compose + send) requires Gmail.

## The flow (per FigJam; CAR-50 unless noted)

1. **Signup → branded verification email → confirm auto-login** *(CAR-52)*: custom SendGrid-SMTP + CareerVine template on the Supabase confirmation email; confirm link opens a signed-in session in a new tab and lands in step 2. Must be verified working, not assumed.
2. **First-login full-screen modal**: "Want access to the curated APM Recruiting Contact bundle?" Yes (visually emphasized) / No. **No-path**: brief app intro + 3 quick-value examples (explicitly low-priority), then dashboard checklist.
3. **Yes → subscribe + apply run in background** (reuse `POST /api/bundles/subscribe` + chunked `/api/bundles/apply` loop, extracted from `data-subscriptions-section.tsx:91-146`). **Progress modal** shows:
   - Live-computed stats (never hardcoded — they drift on republish): N prospects with contact info, N companies with BYU alumni in product roles, N companies with new-grad-PM hiring history, etc. Derivable: 2,000 prospects / 1,420 (71%) BYU alumni / 99 target companies (audited 2026-07-10; alumni = education match on BYU LinkedIn schoolId `4035`).
   - Progress bar tracking the chunked apply loop.
   - **Gmail connect + Google Calendar connect buttons** ("while you wait…") — optional here, but sets up step 7.
4. **Import done → "Pick a target company"** → company list with contacts: BYU-alumni companies badged and sorted top (rank by alumni count — 71% of prospects are alumni, so binary badge alone is weak), hover reveals Select → becomes first **target company** (`addTargetCompany`, `company-queries.ts:1088`).
5. **Company page opens** with a nudge bubble at the prospect list: "select a prospect to email." (Verified: bundle prospects appear here via `contact_companies`; home attention surfaces stay quarantined — active-tier-only filters.)
6. **Email a prospect** → composer modal **pre-filled from a static template** — alumni vs non-alumni variant, merge fields (name, company, alumni status) filled dynamically. No AI dependency. **Fallback:** if Gmail isn't connected yet, inline connect prompt here instead of a dead end.
7. **Send / Schedule Send → follow-up offer**: "Schedule follow-ups that only send if they don't reply?" Yes emphasized. Yes → **3 stacked templated follow-ups, default 1 week apart, editable cadence** → Schedule. Reply-detection auto-cancel already exists (`checkForReplyInThread`).
8. **Finale**: confetti congrats → after ~5s, "there's more" bullets (Chrome extension / personalized action suggestions / calendar availability insertion) → **"Grow your Career Vine"** button ends the intro.

**Escape hatch (every step):** a quiet "skip for now" drops to the dashboard + reworked Getting Started checklist (explore target list → pick a company → connect Gmail → try extension (real link) → log first conversation). A closed modal must never strand the user.

**PostHog funnel** (CAR-38 registry, `object_verb` past tense): signup → verified → bundle accepted → sync done → company picked → prospect selected → email sent → follow-ups scheduled → intro completed. Instrument the No-path and skips too.

## AI trial (CAR-51 — unchanged mechanics, reduced onboarding role)

24h shared-key window starting at **first AI use**; per-account caps via CAR-41 limiter on all shared-key AI routes; `expires_at timestamptz` on `user_ai_access` (NULL = permanent admin grants); gate in `hasSharedAccess` (`openai.ts:151-173`). Expiry → locked state with BYO-key + "Request AI access" exits. Onboarding no longer depends on it (templates, not AI); the trial's job is making the extension parse + AI drafting work in the post-onboarding window.

## Verified premises (audited 2026-07-10)

- Bundle: 2,000 records, 1,420 BYU alumni (education arrays on all), photos on R2, ~667 distinct current employers → picker driven by in-app records with counts (`getCompanies`, `company-queries.ts:322`, has `logo_url` + per-tier counts), not static companies.json (99).
- Prospect quarantine: all home attention surfaces filter `network_status='active'` (`queries.ts:1827`, `generate-suggestions.ts:53`); imports land as prospect, null cadence; checklist survives bundle apply (`page.tsx:693`).
- Discovery does NOT light up on company pick (weekly cron, admin-gated, paid) — onboarding copy must not promise it.
- PostHog fully wired (`analytics/client.tsx`, registry `analytics/events.ts`).
- Duplicate-email detection (`auth-provider.tsx:104-113`, CAR-46) depends on confirmations-ON behavior — keeping verification (v2) means it keeps working as-is.
- Supabase branded email = dashboard SMTP settings (SendGrid, domain-authenticated) + email template; no config.toml in repo.

## Build inventory (final audit, 2026-07-10 — three read-only agents)

**Confirmed broken today (CAR-52 is a real fix, not just config):** the confirm-link auto-login does NOT work. The browser client is `@supabase/ssr` PKCE-default (`browser-client.ts:14-20`), `signUp` passes no `emailRedirectTo` (`auth-provider.tsx:85-97`), and there is no `/auth/confirm` route calling `verifyOtp` — so a confirm click in a new tab lands **unauthenticated** on the landing page. Fix (canonical @supabase/ssr pattern): new `src/app/auth/confirm/route.ts` route handler doing server-side `verifyOtp({token_hash, type})` → redirect into onboarding; `emailRedirectTo: ${origin}/auth/confirm` on signUp (mirror `resetPassword`'s `redirectTo`, line 163); dashboard email template → `token_hash` link form; `/auth/confirm` added to the redirect-URL allowlist per environment. Works cross-tab/device because it doesn't need the PKCE verifier.

**New build (the one big piece):** static merge-field template system. `email_templates` today stores AI *prompts* only (`{name, prompt}`); zero `{{merge_field}}` capability exists anywhere. Need: template store with subject/body, merge resolver (name/company/alumni), alumni vs non-alumni variant selection.

**New build (small):** `users.onboarding_state` column (migration) — no persistent first-login/onboarding flag exists; `isNewUser` is ephemeral (`contactHealth.length===0`). Needed for show-once + resume-after-interrupt. Bundle apply progress is client-held (cursor + React state), but durable signals (`bundle_subscriptions.synced_version < version`, `sync_claimed_until`, `bundle_contact_state.apply_started_at`) suffice to detect mid-flight and re-show a syncing state.

**Rewire, not build:**
- Composer prefill is first-class: `openCompose({to, name, subject, bodyHtml, contactId, isIntro…})` (`compose-email-context.tsx:18-30`). Company-page per-contact compose buttons already exist (`pipeline-layout.tsx:574`, `person-modal.tsx:203`) — just pass template-rendered subject/body through.
- Follow-up sequence engine is **content-agnostic and AI-free at the data layer**: `email_follow_ups` + `email_follow_up_messages` persist caller-supplied subject/body/delays; reply auto-cancel (`checkForReplyInThread`) lives in the sequence cron and applies regardless of content source. The stacked-3-emails editor already exists (`follow-up-plan-section.tsx` — per-step subject/body/delay/toggle) but is gated behind "Approve intro & generate follow-ups" (AI); seed it from templates and ungate instead.
- Gmail/Calendar connect is triggerable from any component (`GET /api/gmail/auth`, `?scopes=calendar`) — but the OAuth callback **hardcodes redirect to /settings** (`callback/route.ts:89`); thread a `returnTo` through the CSRF `state` so onboarding keeps the user.
- Alumni data: fully derivable **today, no schema change** — bundle education persists to `contact_schools`/`schools` (`bulk-import.ts:563,708-736`), and the app already ships `isByuSchoolName` (`company-queries.ts:52`) + per-person `is_alum` (`company-queries.ts:672-675`, surfaced in pipeline/person-modal/dossier). Picker counts = contact_companies → contact_schools → schools join with that predicate. Note: bundle imports leave `contacts.verified_school` null — the schools-join is the reliable signal, not that column.

**Minor:** cron cadence discrepancy — ops notes say send-follow-ups */10min, code comments say 15min; verify against QStash when touching. (One audit agent claimed "no migrations directory exists" — false; it searched `careervine/supabase`. Migrations live at repo-root `supabase/migrations/`, per rule 12.)

## Sequencing

CAR-52 (branded email + confirm auto-login) first — it's the flow's front door and small. CAR-50 is the bulk (modal sequence, picker, templates, finale) and can start in parallel. CAR-51 independent, any time before/after. Template authoring (alumni/non-alumni cold email + 3 follow-ups) is CAR-50 scope and needs Dawson's voice review before launch.

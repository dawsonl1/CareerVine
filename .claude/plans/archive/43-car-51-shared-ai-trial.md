# CAR-51 — 24-hour shared-AI trial (first-use clock, spend caps, expiry UX)

Every account gets shared-OpenAI-key access for a 24-hour window that starts at their **first AI use** (not signup). After expiry: BYO key or a manual grant, with a graceful locked state — never a raw failure.

## 1. Schema (migration `20260710160000_ai_trial_expiry.sql`)

- `ALTER TABLE user_ai_access ADD COLUMN expires_at timestamptz;` — NULL = permanent grant, so every existing admin grant is untouched.
- `ADD COLUMN access_requested_at timestamptz;` — when the user last clicked "Request AI access" (dedupes the notification).
- Update hand-maintained `careervine/src/lib/database.types.ts` to match.
- **Both admin grant routes** (`api/admin/ai-access`, `api/admin/users/[id]/ai-policy`) now explicitly set `expires_at: null` on grant — upsert keeps unspecified columns on conflict, so without this a stale trial `expires_at` would keep a manually-granted user locked.

## 2. Gate + trial start (`careervine/src/lib/openai.ts`)

- `hasSharedAccess` becomes expiry-aware `resolveSharedAccess(userId) → { granted, trialExpired }`, cached 60s, fail-closed:
  - `granted = shared_access && (expires_at IS NULL || expires_at > now)`.
  - `trialExpired = granted_by === 'trial' && expires_at <= now` — drives the distinct failure code.
- **Trial start**: in the shared-key resolution paths (`resolveWithoutPersonalKey` and `fallbackToSharedOrFail`), a user with **no row** gets one created atomically: `upsert({ shared_access: true, granted_at: now, granted_by: 'trial', expires_at: now+24h }, { ignoreDuplicates: true, count: 'exact' })`. `count === 1` = we started the trial (emit `ai_trial_started`); `count === 0` = concurrent insert won, re-read and evaluate. Trials never re-arm: any existing row (including `shared_access=false` cutoffs) blocks creation.
- **Lazy expiry flip**: when a read finds `shared_access=true` but `expires_at <= now`, atomically `update({ shared_access: false }) .eq(user_id) .eq(shared_access, true) .lte(expires_at, now)` with `count: 'exact'` (per rule 17 — no `.select()` on CAS updates). `count === 1` is the one-time transition → emit `ai_trial_expired` exactly once. `granted_by`/`expires_at` stay as the trial tombstone.
- New failure code **`ai_trial_expired`** returned from `resolveWithoutPersonalKey` when denied + `trialExpired` + no personal key. Key-specific codes (`ai_key_invalid`, `ai_quota_exhausted`) keep priority — they're more actionable for users who have a key.

## 3. Spend caps — per-user rate limits on every shared-key AI route

Reuse the CAR-41 limiter (`withApiHandler`'s `rateLimit`). Sliding-window, sized to be invisible in normal use (belt-and-suspenders; emails are verified per CAR-52):

| Route | Bucket | Limit |
|---|---|---|
| `api/ai/draft-intro` | `careervine-ai-draft-intro` | 30 / 1h |
| `api/ai/draft-follow-ups` | `careervine-ai-draft-follow-ups` | 30 / 1h |
| `api/gmail/ai-write` | `careervine-ai-write` | 40 / 1h |
| `api/gmail/ai-followups/generate` | `careervine-ai-followups` | 30 / 1h |
| `api/transcripts/parse` | `careervine-transcripts-parse` | 12 / 1h |
| `api/transcripts/extract-actions` | `careervine-transcripts-extract` | 20 / 1h |
| `api/transcripts/match-speakers` | `careervine-transcripts-speakers` | 20 / 1h |
| `api/extension/parse-profile` | existing `careervine-parse-profile` | 60 / 1h (unchanged) |
| `api/ai/request-access` (new) | `careervine-ai-request-access` | 3 / 1h |

## 4. Expiry UX

- **New `AiFailureCode` `ai_trial_expired`** in `ai-errors.ts` + the extension mirror (`chrome-extension/panel-app/src/ai-failure.ts`). Copy: "Your free AI day has ended" / add-your-key primary CTA, non-retryable.
- **`AiUnavailableNotice`** renders a secondary **"Request AI access"** button for this code: POSTs `/api/ai/request-access`, flips to a "Request sent — you'll get an email when it's enabled" confirmation (also when the server says it was already requested).
- **New route `POST /api/ai/request-access`**: upserts `access_requested_at = now` on the user's row, dedupes (no re-notify within 7 days), notifies Dawson, emits `ai_access_requested`. Doubles as the engaged-user signal.
- **Notify Dawson**: net-new tiny helper `src/lib/admin-notify.ts` — plain `fetch` to SendGrid v3 (`SENDGRID_API_KEY`), From `healthcheck@dawsonsprojects.com`, To `dawsonlpitcher@gmail.com`, fail-soft (request still recorded if email fails; no-op + warn when the key is unset). Claude adds `SENDGRID_API_KEY` to Vercel prod env (rule 28).
- **Quiet trial note**: `GET /api/settings/openai-key` gains `sharedAccessExpiresAt` + `trialState: 'active' | 'expired' | null`; `ai-key-section` shows "AI included — your first day is on us" during the active trial and the locked/request-access state after expiry. Extension locked state links to Settings → AI (request button lives there / in the notice — no new extension flow).

## 5. Analytics (CAR-38 registry)

- `ai_trial_started: {}` — server, at trial-row creation.
- `ai_trial_expired: {}` — server, on the one-time lazy flip.
- `ai_access_requested: {}` — server, from the request-access route.

## 6. Tests & verification

- Extend `openai-routing.test.ts`: trial starts on first no-row resolution (row payload + event), concurrent-insert race path, expired trial denies with `ai_trial_expired`, one-time expiry flip/event, permanent grants unaffected, expiry within cache TTL semantics.
- New `ai-request-access-route.test.ts`: happy path, dedupe window, fail-soft email.
- Update `ai-access-route` / `ai-policy` tests for `expires_at: null` on manual grant; `ai-errors` + `ai-unavailable-notice` tests for the new code + secondary CTA.
- `npm run test` + `npm run build` from `careervine/`; migration applied via `supabase db push` (dry-run first) after merge, per rule 27.

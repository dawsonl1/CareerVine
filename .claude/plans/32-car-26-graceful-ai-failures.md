# 32 — Graceful failures for every AI feature (CAR-26)

**Linear:** [CAR-26](https://linear.app/career-vine/issue/CAR-26/we-need-graceful-failures-in-every-ai-enabled-feature-ui-for-when-the) · Priority: None (set) · Effort: Medium–Large
**Depends on:** plan 29 (BYO OpenAI keys / CAR-16) — **already shipped** (`user_api_keys`, `lib/crypto.ts`, `lib/openai.ts` routing, Settings → AI tab).

Every AI-enabled feature must fail gracefully — with a clear, actionable message — in the three token states the ticket names:

1. **Usage spent** — the OpenAI key that would serve the request is out of quota (`insufficient_quota`).
2. **Token invalid** — the key was rejected (401 `invalid_api_key`).
3. **No token + no shared access** — the user has added no key of their own *and* is not entitled to CareerVine's shared key.

Today none of these three reliably surface: they either silently fall back to the shared key or collapse into a generic `500 "Failed to …"`.

---

## 1. Current state & the gap

### What exists (from plan 29)
- `lib/openai.ts` routes each user through `getOpenAIForUser(userId)` → `{ client, source: "user" | "app" }` and `runWithOpenAIFallback(userId, fn)`.
- On a **user-key** 401 → mark `invalid`, **retry on the app/shared key**. On **user-key** `insufficient_quota` → mark `quota_exceeded`, **retry on the app/shared key** (`openai.ts:270-288`).
- The only place any of this surfaces to a user is `components/settings/ai-key-section.tsx` (a Settings-only banner). Nothing surfaces *inside* the features.

### The three gaps CAR-26 closes
1. **No shared-token gating.** `getOpenAIForUser` falls back to the app key *unconditionally* for every user (`openai.ts:220,224,234,241`). There is no entitlement anywhere. So "no access to my shared token" (ticket case 3) is currently impossible — everyone has access. **This is the mechanism that turns silent fallback into a real, surfaced failure**, and it must be built first.
2. **No machine-readable failure cause reaches the client.** `ApiError` carries only `{ message, status }` → `withApiHandler` emits `{ error: message }` (`api-handler.ts:21-29, 173-178`). Every AI route's local `try/catch` collapses quota / invalid / missing into one generic `ApiError(…, 500)`. The distinct cause is known only inside `lib/openai.ts` and then discarded.
3. **Feature UIs have no graceful state.** Several show nothing at all on failure (silent `catch {}` in `follow-up-modal.tsx`, `past-meeting-fields.tsx`, `use-suggestions.ts`); the rest show a generic inline string with no next step.

### Decisions locked for this plan (2026-07-09)
- **Shared-token access = per-user flag, default OFF.** New users must bring their own key; shared access is granted selectively. Maximizes control over app-side OpenAI spend.
- **Silent on successful fallback.** If a user has shared access and their own key fails, we fall back to the shared key and stay silent in-feature (the Settings banner already covers it). In-feature failure UI fires **only when no key can serve the request**.
- **Deepgram transcription is in scope** (graceful state instead of its current silent `catch {}`). The **orphaned article follow-up pipeline is out of scope** (no wired UI trigger today).

---

## 2. Failure taxonomy (the contract)

One closed set of machine codes, shared by backend and frontend. All four are emitted over HTTP **402** (unused elsewhere in the app, so the client can fast-path on status *and* branch on `code`). 402 here means "AI unavailable for this user," not literal payment.

| `code` | When | Surfaced copy (title / body / CTA) | Retryable |
|---|---|---|---|
| `ai_no_key` | No personal key **and** no shared access | "Add your OpenAI key to use AI" · "CareerVine's AI features need an OpenAI key. Add yours in Settings — with OpenAI's free daily tokens, most people pay nothing." · **Add your key** → `/settings?tab=ai` | no |
| `ai_key_invalid` | Personal key rejected (401), no shared access | "Your OpenAI key was rejected" · "OpenAI didn't accept your key. Update it in Settings to keep using AI features." · **Update key** → `/settings?tab=ai` | no |
| `ai_quota_exhausted` | Personal key out of quota, no shared access | "Your OpenAI key is out of quota" · "Your key hit its usage limit. Add credit or turn on free daily tokens in your OpenAI account, then try again." · **Manage key** → `/settings?tab=ai` | after fix |
| `ai_unavailable` | Shared key itself failing / not configured (for a shared-access user), or any AI provider outage (incl. Deepgram) | "AI is temporarily unavailable" · "We couldn't reach AI right now. Try again in a moment — or add your own OpenAI key so this never blocks you." · **Retry** + **Add your key** → `/settings?tab=ai` | yes |

Copy lives in one place (`lib/ai-errors.ts`), so wording changes are a one-file edit.

---

## 3. Data model — shared-access entitlement

There is **no** general per-user table (no `profiles`/`user_settings`). Add a dedicated one, mirroring the service-role-only lockdown of `user_api_keys`.

New migration `supabase/migrations/20260709130000_create_user_ai_access.sql` (timestamp after the current latest `20260709120000_create_user_api_keys.sql`):

```sql
CREATE TABLE user_ai_access (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_access boolean NOT NULL DEFAULT false,  -- default OFF: no row / false = must BYO
  granted_at    timestamptz,
  granted_by    text,                             -- free-text audit note (e.g. 'admin:dawson')
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_ai_access ENABLE ROW LEVEL SECURITY;

-- Same posture as user_api_keys: service-role only; browser roles get nothing.
CREATE POLICY "user_ai_access_service_role_all" ON user_ai_access
  FOR ALL USING (auth.role() = 'service_role');
REVOKE ALL ON user_ai_access FROM anon, authenticated;
```

- **Boolean, not presence-based**, so a grant can be revoked (`shared_access = false`) while keeping the audit trail.
- No row → treated as `false` (default OFF).
- Regenerate `careervine/src/lib/database.types.ts` to include the table.
- Applied to prod by Dawson via `supabase db push` (rule 11/15).

---

## 4. Backend changes

### 4.1 Error contract — `lib/api-handler.ts`
Extend `ApiError` with an optional machine code and echo it in the JSON:

```ts
export class ApiError extends Error {
  constructor(message: string, public status = 400, public code?: string) { … }
}
// in the catch-all:  jsonResponse({ error: error.message, code: error.code }, error.status, headers)
```
Backwards-compatible — `code` is optional and omitted for existing errors.

New subclass (in `lib/ai-errors.ts`, imported where thrown):
```ts
export class AiUnavailableError extends ApiError {
  constructor(public reason: AiFailureCode) {
    super(AI_FAILURE_COPY[reason].serverMessage, 402, reason);
  }
}
```

### 4.2 Resolution model — `lib/openai.ts`
Change `getOpenAIForUser` so it can report "no usable key" instead of always returning the app client.

```ts
export type OpenAIResolution =
  | { ok: true; client: OpenAI; source: "user" | "app" }
  | { ok: false; code: AiFailureCode };
```

Resolution logic:
1. Look up the user's `user_api_keys` row (as today).
2. **Personal key eligible** (`isUserKeyEligible`) → `{ ok, client: user, source: "user" }`. *(Unchanged hot path; no entitlement query.)*
3. Otherwise, **lazily** look up `user_ai_access.shared_access` (only on this branch; cache 60s alongside the key cache):
   - `shared_access === true` **and** app key configured → `{ ok, client: app, source: "app" }`.
   - else map to a failure code:
     - personal row `status = 'invalid'` → `ai_key_invalid`
     - personal row `status = 'quota_exceeded'` → `ai_quota_exhausted`
     - no personal row → `ai_no_key`
     - shared access granted but app key env missing → `ai_unavailable`
   - return `{ ok: false, code }`.
4. Any unexpected lookup/decrypt exception → `{ ok: false, code: "ai_unavailable" }` (never a raw crash; keep the plan-29 best-effort posture, just typed).

### 4.3 Fallback + call wrapper — `runWithOpenAIFallback`
```ts
export async function runWithOpenAIFallback<T>(userId, fn): Promise<T> {
  const r = await getOpenAIForUser(userId);
  if (!r.ok) throw new AiUnavailableError(r.code);       // no usable key → typed failure

  try {
    const out = await fn(r.client);
    if (r.source === "user") void markKeyStatus(userId, "active");
    return out;
  } catch (err) {
    // source === "app": the SHARED key failed.
    if (r.source === "app") {
      if (isAuthError(err) || isQuotaError(err)) throw new AiUnavailableError("ai_unavailable");
      scrubOpenAIError(err);                              // generic, propagates as today
    }
    // source === "user": mark, then fall back IF entitled, else typed failure.
    const entitled = await hasSharedAccess(userId);       // cached
    if (isAuthError(err)) {
      evictOpenAIKeyCache(userId); void markKeyStatus(userId, "invalid");
      if (!entitled) throw new AiUnavailableError("ai_key_invalid");
      try { return await fn(getAppOpenAIClient()); }
      catch (e2) { if (isAuthError(e2) || isQuotaError(e2)) throw new AiUnavailableError("ai_unavailable"); scrubOpenAIError(e2); }
    }
    if (isQuotaError(err)) {
      evictOpenAIKeyCache(userId); void markKeyStatus(userId, "quota_exceeded");
      if (!entitled) throw new AiUnavailableError("ai_quota_exhausted");
      try { return await fn(getAppOpenAIClient()); }
      catch (e2) { if (isAuthError(e2) || isQuotaError(e2)) throw new AiUnavailableError("ai_unavailable"); scrubOpenAIError(e2); }
    }
    scrubOpenAIError(err);                                 // rate-limit/5xx/network → generic
  }
}
```
This preserves the **silent-on-successful-fallback** contract (entitled users never see a code when fallback works) and produces a typed failure only when no path serves the request.

### 4.4 Admin grant route (no admin UI)
Follow the existing `BUNDLE_ADMIN_TOKEN` bearer pattern (`api/admin/bundles/publish/route.ts`). New:

`POST /api/admin/ai-access` — body `{ userId | email, sharedAccess: boolean }`, authed by `isAuthorizedAdminToken(header, process.env.BUNDLE_ADMIN_TOKEN)` (reuse) — upserts `user_ai_access` (service client), sets `granted_at`/`granted_by`, evicts the routing cache for that user. Grant/revoke is a `curl` from Dawson's machine; no UI is needed for v1.

### 4.5 Route changes (stop swallowing the typed failure)
Every AI route currently converts *any* thrown error into a generic `ApiError(…, 500)`. In each, **let `AiUnavailableError` through untouched** before the generic conversion:
```ts
} catch (err) {
  if (err instanceof AiUnavailableError) throw err;   // ← add this line
  throw new ApiError("Failed to …", 500);
}
```
Sites (all confirmed via inventory):

| Route | File | Note |
|---|---|---|
| draft-intro | `api/ai/draft-intro/route.ts` | |
| draft-follow-ups | `api/ai/draft-follow-ups/route.ts` | keep the fabricated-fallback for *partial* misses; a hard `AiUnavailableError` must still bubble |
| ai-write | `api/gmail/ai-write/route.ts` | body call; subject call already swallowed — leave swallowed (fallback runs first) |
| transcripts/parse | `api/transcripts/parse/route.ts` | |
| transcripts/match-speakers | `api/transcripts/match-speakers/route.ts` | |
| transcripts/extract-actions | `api/transcripts/extract-actions/route.ts` | |
| extension/parse-profile | `api/extension/parse-profile/route.ts` | emits code for the extension client (see §6) |
| suggestions/generate | `api/suggestions/generate/route.ts` + `lib/ai-followup/generate-suggestions.ts` | see §5 Feature 9 for the light treatment |
| transcripts/transcribe (Deepgram) | `api/transcripts/transcribe/route.ts` | not OpenAI — on missing key / provider error, throw `AiUnavailableError("ai_unavailable")` |

**Suggestions library exception:** `generate-suggestions.ts` swallows LLM errors and returns `[]` by design (rule-based suggestions still return). Change: catch the OpenAI error, and if it is an auth/quota failure with **no shared fallback available**, attach the resolved `code` to the route response (e.g. `{ suggestions, aiStatus?: code }`) instead of throwing — so the dashboard can show a *quiet* prompt, not a hard error card (§5 Feature 9).

---

## 5. Frontend — one shared layer, wired into every feature

### 5.1 Shared helper — `lib/ai-errors.ts`
- `type AiFailureCode = "ai_no_key" | "ai_key_invalid" | "ai_quota_exhausted" | "ai_unavailable"`
- `AI_FAILURE_COPY: Record<AiFailureCode, { title; body; ctaLabel; ctaHref; serverMessage; retryable }>` (§2 table).
- `parseAiFailure(res: Response, data: unknown): AiFailureCode | null` — returns the code when `res.status === 402` and `data.code` is a known `ai_*` code, else `null`. This is the single detection point; no string-matching on messages anywhere.

### 5.2 Shared component — `components/ai/ai-unavailable-notice.tsx`
Small, presentational, styled to match the existing `ai-key-section.tsx` banner (consistency, rule 5):
```tsx
<AiUnavailableNotice code={code} onRetry?={() => …} inline?={true} />
```
- Renders icon + title + body + CTA link to `/settings?tab=ai`.
- Shows a **Retry** button only when `AI_FAILURE_COPY[code].retryable`.
- `inline` variant (compact, fits inside a modal's error region) vs a slightly larger card variant for full-panel features.

### 5.3 Per-feature wiring
Each feature already has an error branch; thread a structured `aiFailure: AiFailureCode | null` alongside the existing `error` string. On a failed fetch, call `parseAiFailure`; if it returns a code, render `<AiUnavailableNotice>` and **do not** show the generic string.

| # | Feature | Component | Treatment |
|---|---|---|---|
| 1 | Intro email draft | `compose-email-modal.tsx` (intro step) | replace `introError` string with notice in the same region |
| 2 | Follow-up sequence | `compose-email-modal.tsx` | replace `followUpError` string with notice; keep partial-fill fallback |
| 3 | Write-with-AI dropdown | `ai-write-dropdown.tsx` | notice inline under the dropdown |
| 4 | Write-with-AI (follow-up modal) | `follow-up-modal.tsx` | **fix silent `catch {}`** → capture code, show inline notice; also fix the `data.body` vs `bodyHtml` mismatch found in inventory |
| 5 | Transcript parse | `transcript-uploader.tsx` | **currently ignores `data.error`** → read `code`, show notice in the status area |
| 6 | Speaker matching | `speaker-resolver.tsx` | map thrown error to notice in its error state |
| 7 | Extract action items | `meetings/transcript-action-suggestions.tsx` | notice in the panel's error slot |
| 8 | Audio transcription (Deepgram) | `conversation-modal/past-meeting-fields.tsx` | **fix silent `catch {}`** → show `ai_unavailable` notice with Retry |
| 9 | Smart suggestions | `use-suggestions.ts` + `app/page.tsx`, `app/action-items/page.tsx` | **light touch:** hook reads optional `aiStatus` code; dashboard shows a small, dismissible inline prompt ("Add your OpenAI key to get AI suggestions") — never a blocking error card (background enhancement) |

### 5.4 Settings AI section — close the loop
- Extend `GET /api/settings/openai-key` to also return `sharedAccess: boolean` (from `user_ai_access`).
- In `ai-key-section.tsx`, the **no-key empty state** branches on it: with shared access → "You're covered by CareerVine's shared AI. Add your own key to use your account instead." Without → "Add your OpenAI key to turn on AI features." This makes the deep-linked CTA destination coherent with what the user sees.

---

## 6. Chrome extension (parse-profile)

The extension lives in `/chrome-extension` (outside the Next app). The route (`api/extension/parse-profile`) already returns the typed 402 `code` after §4.5. Extension-side work (own commit): read `code` from the 402 response and render the same four messages in the extension's profile-import UI, with the CTA deep-linking to the web app's `/settings?tab=ai`. Keep copy identical to `AI_FAILURE_COPY` (duplicate the small map in the extension; no shared bundle between the two projects today).

---

## 7. Tests (Vitest, `careervine/src/__tests__/`)

- **`openai-routing.test.ts`** (extend): no key + no shared access → `{ ok:false, ai_no_key }`; invalid key + no access → `ai_key_invalid`; quota + no access → `ai_quota_exhausted`; invalid/quota **with** access → silent app fallback (still `ok:true`, `source:"app"`, no throw); shared key itself 401/quota → `ai_unavailable`; entitlement lookup cached (no double query).
- **`run-with-fallback.test.ts`**: user-key 401, entitled → returns app result, no throw; user-key 401, not entitled → throws `AiUnavailableError("ai_key_invalid")`; scrubbed error never contains an `sk-` fragment (carry over plan-29 assertion).
- **`ai-access-route.test.ts`**: admin token required (401 without); grant upserts `shared_access=true`; revoke sets false; cache evicted.
- **`api-handler.test.ts`** (extend): `ApiError` with `code` → JSON includes `code`; without → omitted.
- **`ai-errors.test.ts`**: `parseAiFailure` returns the code on 402 + known code, `null` otherwise (unknown code, non-402, missing body).
- **Route-level**: at least one route (`transcripts/parse`) proves a no-usable-key resolution returns 402 with the right `code` through the route's `try/catch` (pins the "let `AiUnavailableError` through" line against regression).
- **Component**: `AiUnavailableNotice` renders correct copy + CTA href per code; Retry shown only when retryable.

Run `npm run test` in `careervine/` before every commit (rule 4).

---

## 8. Rollout / ops (Dawson, post-merge)

1. `supabase db push` to create `user_ai_access`.
2. **Default OFF means existing users lose shared fallback on deploy.** Decide who keeps it: grant trusted existing accounts via `POST /api/admin/ai-access` (or a one-off seed), otherwise they'll be prompted to BYO. At minimum, grant Dawson's own account. *(This app is early-stage, so the blast radius is small — but do this before/at deploy so no one is surprised.)*
3. No new env vars (reuses `OPENAI_API_KEY`, `BYOK_ENCRYPTION_KEY`, `BUNDLE_ADMIN_TOKEN`). Auto-deploys on push to `main` (rule 16).
4. README (rule 7): note that AI features work with your own OpenAI key, and that CareerVine may extend courtesy shared access.

---

## 9. Implementation order (each = commit + push)

1. **Entitlement data model** — migration `20260709130000_create_user_ai_access.sql`, regenerate `database.types.ts`.
2. **Error contract + taxonomy** — `ApiError.code` in `api-handler.ts`; new `lib/ai-errors.ts` (codes, copy, `AiUnavailableError`, `parseAiFailure`) + tests.
3. **Routing core** — `getOpenAIForUser` returns `OpenAIResolution`; `runWithOpenAIFallback` entitlement-aware fallback; `hasSharedAccess` + cache; routing tests. *(No UI change yet; call sites still compile — `runWithOpenAIFallback` still returns `T` or throws.)*
4. **Admin grant route** — `api/admin/ai-access` + tests.
5. **Route pass-through** — add the `instanceof AiUnavailableError` re-throw to all §4.5 routes; suggestions library `aiStatus`; Deepgram route typed failure.
6. **Shared frontend layer** — `ai-unavailable-notice.tsx` + component test.
7. **Feature wiring** — features 1–8 (§5.3), fixing the three silent catches; feature 9 light touch; Settings `sharedAccess` empty-state.
8. **Extension** — parse-profile 402 handling (separate `/chrome-extension` commit).
9. **Docs** — README + rollout notes.

---

## 10. Out of scope (v1)

- Article-based follow-up pipeline (Feature 10) — no wired UI trigger; revisit when it ships.
- Per-user token metering / usage counters (no precedent; `quota_exceeded` remains reactive, not a local counter).
- Admin UI for granting shared access (token + `curl` is enough for now).
- Proactive "your key is about to run out" warnings — we react to `insufficient_quota`, we don't predict it.
- Other providers' BYO (schema's `provider` column already future-proofs OpenAI-only routing).
```

# 33 — BYO Google Gemini (DeepMind) API Keys (CAR-30)

**Linear:** [CAR-30](https://linear.app/career-vine/issue/CAR-30/add-the-ability-for-any-user-to-add-their-own-google-gemini-deepmind) · Priority: Medium · Effort: Medium
**Precursor:** [CAR-16](https://linear.app/career-vine/issue/CAR-16) / plan `29-byo-openai-keys.md` — read that first; this plan is a deliberate parallel and reuses ~60% of its machinery.

Let any user paste their own **Google Gemini API key** (`AIza…`, from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)) so their AI usage bills to *their* Google account. Same security posture as BYO OpenAI: encrypted at rest, never readable by the client, per-user routing with graceful fallback to an app key. The new wrinkle vs. CAR-16: OpenAI was the *only* provider, so there was nothing to choose. Now there are two, so we introduce a **per-user provider preference**.

---

## 0. The core design decision (read before anything else)

CareerVine's 12 AI call sites are hardwired to OpenAI in two ways: they build an OpenAI SDK client, and 8 of them use OpenAI's **Responses API** (`client.responses.create`). Gemini can't be dropped in without addressing both. Three strategies were weighed:

| Strategy | How | Verdict |
| --- | --- | --- |
| **A. Native `@google/genai` SDK** | Add the Google SDK, write a second set of call implementations with Gemini's request/response shape. | Rejected — doubles every prompt/call site, two SDKs to maintain, most code duplicated. |
| **B. OpenAI-compat endpoint (RECOMMENDED)** | Gemini exposes an OpenAI-compatible surface at `https://generativelanguage.googleapis.com/v1beta/openai/`. Reuse the **existing `openai` npm SDK** — just swap `baseURL` + `apiKey` + model name. | **Chosen.** One SDK, one set of call code, provider differs only by client config. |
| **C. Provider SDK abstraction layer** | Full interface (`AIProvider`) both providers implement. | Over-engineered for 2 providers; revisit only if a 3rd (Anthropic) lands. |

**Chosen: Strategy B.** The whole feature collapses to "construct the OpenAI client with a different `baseURL` + key + default model." The one real cost: **Gemini's OpenAI-compat layer supports Chat Completions but NOT the Responses API.** So the 8 `responses.create` call sites must move to a provider-agnostic call that emits Chat Completions. This refactor is the bulk of the engineering (§4.3).

**Provider selection model (v1):** one provider *per user*, not per feature. A user's AI features all run on their chosen provider. Default is `openai` (preserves today's behavior for every existing user with zero migration). This keeps the UX a single clear switch (rule 5) and avoids a routing matrix. Per-feature provider mixing is explicitly out of scope.

> ⚠️ **Open product question for Dawson** — confirm the v1 model before building:
> **(a)** Provider *switch* — the user picks OpenAI **or** Gemini, one key slot active at a time (recommended, simplest UX), **or**
> **(b)** Two independent key cards both stored, with a separate "which do my features use" selector.
> This plan assumes **(a)**. It's a small UI delta either way; the backend is identical.

---

## 1. Security invariants (identical to CAR-16 — non-negotiable)

Every one of these from plan 29 §1 carries over verbatim, with "OpenAI" → "the selected provider" and "OpenAI's servers" → "Google's servers":

1. Plaintext key exists only in three places: the user's paste (TLS POST body), server memory during encrypt/decrypt/use, and Google's servers. Never on disk, in logs, error messages, DB rows (ciphertext only), or any API response.
2. The browser can never read the key back. `user_api_keys` has no `authenticated`-role policy; GET returns metadata only (`hasKey`, `last4`, `status`).
3. Ciphertext is useless without the server — AES-256-GCM, key only in `BYOK_ENCRYPTION_KEY` env.
4. No key material in error paths. Scrub provider errors before rethrow; Gemini save-schema Zod errors must not echo the submitted value.
5. Fallback never silently strands the user — fall back to the app key for the *same provider* and persist a status flag the UI surfaces.
6. Validation before storage — a key is saved only after a live test call to Gemini succeeds.

**Review the final PR against this list**, same as CAR-16.

---

## 2. Data model

**No new table.** `user_api_keys` (created in `20260709120000_create_user_api_keys.sql`) is already `PRIMARY KEY (user_id, provider)` with `provider text NOT NULL DEFAULT 'openai'`. Gemini keys are simply rows with `provider = 'gemini'`. All existing columns (`encrypted_key`, `key_last4`, `status`, `last_validated_at`, `last_used_at`) apply unchanged. The `status` CHECK (`active | invalid | quota_exceeded`) is provider-neutral.

**One new piece of state — the provider preference.** New migration `supabase/migrations/<timestamp>_add_ai_provider_preference.sql`:

```sql
-- Which AI provider a user's features route through. 'openai' = today's default.
ALTER TABLE profiles
  ADD COLUMN ai_provider text NOT NULL DEFAULT 'openai'
    CHECK (ai_provider IN ('openai', 'gemini'));
```

> Confirm the target table — if there is no `profiles` table, store the preference as a second column path or a dedicated `user_ai_settings` row. Check `database.types.ts` for the canonical per-user settings table before writing the migration. The preference is **client-readable** (it's not a secret) — unlike the keys, it can live under normal RLS so the settings UI can read it directly.

Applied by Dawson locally via `supabase db push` (rules 11/15). Regenerate `database.types.ts` after.

---

## 3. Encryption — reuse as-is

No changes. `careervine/src/lib/crypto.ts` (`encryptSecret`/`decryptSecret`, versioned `v1.<iv>.<tag>.<ciphertext>`) and the existing `BYOK_ENCRYPTION_KEY` env var are provider-agnostic and cover Gemini keys with zero modification. No new crypto, no new env for encryption.

---

## 4. Key resolution & routing

### 4.1 New library — `careervine/src/lib/gemini.ts` (mirror of `openai.ts`)

Rather than fork all of `openai.ts`, factor the shared machinery. Recommended shape:

- **`careervine/src/lib/ai/client.ts`** — a `buildOpenAIClient({ apiKey, baseURL?, defaultModel })` used by both providers. Gemini passes `baseURL = "https://generativelanguage.googleapis.com/v1beta/openai/"`.
- **`careervine/src/lib/ai/resolve.ts`** — generalize `getOpenAIForUser` into `getAIClientForUser(userId)` that:
  1. Reads the user's `ai_provider` preference (default `openai`).
  2. Looks up `user_api_keys` for `(user_id, provider)` via the service client.
  3. Applies the **exact same** eligibility / decrypt / fallback / 6-hour quota-cooldown / 60-second-cache logic already in `openai.ts` (lines ~60–243). None of that logic is OpenAI-specific — only the client constructor and default model differ by provider.
  4. Returns `{ client, source: "user" | "app", provider }`.
- Platform fallback keys per provider: `OPENAI_API_KEY` (existing) and **`GEMINI_API_KEY`** (new). If a user selects Gemini but no `GEMINI_API_KEY` is configured and they have no key, features must fail gracefully per [CAR-26](https://linear.app/career-vine/issue/CAR-26)'s policy (surface "no AI available", don't crash).

Default models: `OPENAI_MODEL ?? "gpt-5-mini"` (existing) and `GEMINI_MODEL ?? "gemini-2.5-flash"` (new).

The in-memory cache key must become `(userId, provider)` — a user who switches providers must not be served a stale cached client for the old one. Save/delete/switch endpoints evict the relevant entries.

### 4.2 Fallback runner — `runWithAIFallback`

Generalize `runWithOpenAIFallback(userId, fn)` → `runWithAIFallback(userId, fn)`:

- Resolves the user's provider + client, runs `fn(client, { model })`.
- On `401` → mark that `(user_id, provider)` row `invalid`, retry with the app client **for the same provider**.
- On quota error → mark `quota_exceeded` (6h cooldown), retry with app client.
- Success → mark `active`, touch `last_used_at`.
- Gemini error shapes differ slightly from OpenAI's — the OpenAI-compat layer returns OpenAI-style error bodies, but **verify** the auth-error and quota-error detection (`isAuthError`/`isQuotaError`) against real Gemini 401/429 responses and extend the matchers if needed (Gemini uses HTTP 429 `RESOURCE_EXHAUSTED`).

`createAIRunner(userId)` replaces `createOpenAIRunner`. Keep thin deprecated aliases (`runWithOpenAIFallback`, `createOpenAIRunner`) delegating to the generic versions so the diff at call sites stays mechanical.

### 4.3 The Responses-API → Chat-Completions refactor (the real work)

Gemini's OpenAI-compat endpoint does **not** implement `client.responses.create`. The 8 call sites using it must move to `client.chat.completions.create`. Rather than branch per provider at each site, introduce **one provider-agnostic helper** both providers use:

```ts
// careervine/src/lib/ai/complete.ts
runAI(userId, {
  system?: string,
  input: string,            // the prompt currently passed to responses.create
  maxOutputTokens: number,
}): Promise<string>         // returns the text
```

Internally it calls `chat.completions.create({ model, messages: [{role:'system',...},{role:'user', input}], max_tokens })` through `runWithAIFallback`, and extracts `choices[0].message.content`. Chat Completions is supported by **both** OpenAI and Gemini's compat layer, so this single path serves both providers and removes the Responses-API dependency entirely.

**Migration mechanics per call site** — translate `responses.create({ model, input, max_output_tokens })` → `runAI(userId, { input, maxOutputTokens })`. The 8 sites:

- `src/app/api/ai/draft-intro/route.ts`
- `src/app/api/ai/draft-follow-ups/route.ts`
- `src/app/api/gmail/ai-write/route.ts` (two calls)
- `src/app/api/gmail/ai-followups/generate/route.ts`
- `src/app/api/transcripts/parse/route.ts` (16k tokens — verify Gemini model output cap covers it; `gemini-2.5-flash` supports 8k output by default, may need `gemini-2.5-pro` or chunking — flag)
- `src/app/api/transcripts/match-speakers/route.ts`
- `src/app/api/transcripts/extract-actions/route.ts`
- `src/app/api/extension/parse-profile/route.ts`

The 4 `ai-followup/*` lib functions already use `chat.completions.create` with an injected runner — they need only the runner type generalized, minimal change.

> **Structured-output caveat:** if any Responses-API call relies on `response_format` / JSON-schema structured outputs, verify parity — Gemini's compat layer supports `response_format: { type: "json_object" }` but JSON-*schema* support is narrower. Audit each site's parsing expectations during migration.

---

## 5. Settings CRUD route

`careervine/src/app/api/settings/gemini-key/route.ts` — clone of `openai-key/route.ts`:

- **GET** → metadata only for the `gemini` row.
- **PUT** → rate-limit, `geminiKeySaveSchema` validation, `validateGeminiKey()` (a live test call — smallest possible `chat.completions.create` against the compat endpoint, or the native `GET /v1beta/models` list endpoint), `encryptSecret`, upsert with `provider: "gemini"`, evict cache.
- **DELETE** → delete the `gemini` row, evict cache.

Plus a small **provider-preference endpoint** (or fold into the existing settings PATCH): `PUT /api/settings/ai-provider` writing `profiles.ai_provider`. Switching to a provider the user has no key for is allowed (they'll use the app fallback key, subject to CAR-26 graceful-failure UX) — but the UI should nudge them to add one.

**Validation schema** — `careervine/src/lib/api-schemas.ts`, mirror `openaiKeySaveSchema`:

```ts
export const geminiKeySaveSchema = z.object({
  apiKey: z.string().trim().min(30).max(200)
    .regex(/^AIza[0-9A-Za-z_-]+$/, "That doesn't look like a Gemini API key."),
});
```

(Google AI Studio keys are `AIza` + 35 chars today; keep the bound loose. Custom message so Zod never echoes the value — invariant #4.)

---

## 6. Settings UI

`careervine/src/components/settings/ai-key-section.tsx` currently renders the OpenAI card. Generalize to support both providers under the existing **Settings → AI** tab:

- A **provider selector** (segmented control / radio: "OpenAI" · "Google Gemini") bound to `ai_provider`.
- Below it, the key card for the selected provider — the existing card, parameterized by provider (label, placeholder `AIza…` vs `sk-…`, endpoints `/api/settings/gemini-key` vs `/api/settings/openai-key`, status badges reused).
- Gemini-specific instructional copy: link to [aistudio.google.com/apikey](https://aistudio.google.com/apikey), note the genuinely-free tier, and the data-use disclosure (Google may use free-tier API data to improve products — call this out honestly, same spirit as the OpenAI free-token warning).
- Reuse `ai-key-video.tsx` pattern for a Gemini how-to (or make the video prop-driven per provider; a placeholder link is fine for v1).

Keep it clean — one provider's card visible at a time, no dual clutter (rule 5). Factor the card into a `<ProviderKeyCard provider="openai|gemini" />` so both share one implementation.

---

## 7. Environment variables

| Var | Purpose | Where |
| --- | --- | --- |
| `GEMINI_API_KEY` | Platform/default Gemini key (fallback) | Vercel prod+preview, local `.env.local` |
| `GEMINI_MODEL` | Optional model override, default `gemini-2.5-flash` | optional |
| `BYOK_ENCRYPTION_KEY` | **Unchanged** — reused for Gemini ciphertext | already set |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | **Unchanged** | already set |

After adding Vercel envs, trigger a redeploy (empty commit) so they take effect (rule 16). Document in README deploy notes + PR description.

---

## 8. Tests (mirror CAR-16's suite)

Under `careervine/src/__tests__/`:

- **`gemini-routing.test.ts`** (clone `openai-routing.test.ts`) — user-vs-app resolution for `provider='gemini'`, provider-preference honored, 401/quota fallback, `(userId, provider)` cache isolation (switching provider doesn't serve stale client), `markKeyStatus`.
- **`gemini-key-route.test.ts`** (clone `openai-key-route.test.ts`) — GET/PUT/DELETE, encryption round-trip, rate-limit, `validateGeminiKey` 401→rejected mapping.
- **`api-schemas.test.ts`** — add `geminiKeySaveSchema` cases (accepts `AIza…`, rejects `sk-…`, rejects short/echo-free).
- **Provider-preference test** — default `openai` for untouched users; switching persists; resolution reads it.
- Extend `crypto.test.ts`? No — crypto is unchanged; existing coverage suffices.
- Update any test asserting a call site routes through `runWithOpenAIFallback` (e.g. `transcripts-parse-byo.test.ts`) to the generalized `runWithAIFallback`.

Run `npm run test` from `careervine/` and confirm green before commit (rule 4).

---

## 9. Privacy & docs

- **`careervine/src/app/privacy/page.tsx`** (lines ~42, 57–58, 77–78 today describe OpenAI-only) — add that when a user selects Gemini, prompt content is processed by **Google** under their API terms; note the free-tier data-use caveat. Keep it factual.
- **README** — product-framed update: users can now bring an OpenAI *or* Google Gemini key; Gemini's free tier lowers the barrier. Describe the value, not the wiring (rule 7).

---

## 10. Build order (suggested PR slices)

1. **Migration + types** — `ai_provider` preference column, regenerate `database.types.ts`. (Dawson applies via `supabase db push`.)
2. **Library refactor** — factor `openai.ts` → `ai/{client,resolve,complete}.ts` + `runWithAIFallback` + `runAI`, keeping OpenAI-only behavior identical (no Gemini yet). Ship + verify all existing AI features still work. *This de-risks the big refactor before Gemini enters.*
3. **Responses→Chat migration** — move the 8 call sites to `runAI`. Still OpenAI-only. Tests green.
4. **Gemini provider** — `GEMINI_API_KEY`/`GEMINI_MODEL`, compat-endpoint client, `validateGeminiKey`, `geminiKeySaveSchema`, `/api/settings/gemini-key`, provider-preference endpoint.
5. **UI** — provider selector + parameterized `ProviderKeyCard`.
6. **Privacy + README + tests + env docs.**

Slices 2–3 are the risky part and are provider-agnostic — landing them first means Gemini becomes a thin addition, and any regression is caught while still on the known-good OpenAI path.

---

## 11. Risks / things to verify during build

- **Output-token ceilings** — `transcripts/parse` asks for 16k output tokens. Confirm the chosen Gemini model's max output; `gemini-2.5-flash` may need a `pro` variant or the request re-tuned. Don't silently truncate transcripts.
- **Structured-output parity** — audit each `responses.create` site for JSON-schema reliance before assuming the Chat-Completions shim is lossless (§4.3 caveat).
- **Error-shape detection** — validate `isAuthError`/`isQuotaError` against real Gemini 401/429 (`RESOURCE_EXHAUSTED`) bodies via the compat layer.
- **Rate-limit differences** — Gemini free tier has low RPM/RPD limits; the quota-cooldown flag will fire more often. The 6h cooldown may be too long for Gemini's *daily* resets — consider a shorter cooldown for `provider='gemini'`.
- **Compat-layer coverage** — confirm the OpenAI-compat endpoint covers every param we pass (`max_tokens`, `temperature`, `response_format`); fall back to native `@google/genai` only if a needed feature is missing (would push toward Strategy A for that one call — avoid if possible).

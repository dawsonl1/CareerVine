# 29 — BYO OpenAI API Keys (CAR-16)

**Linear:** [CAR-16](https://linear.app/career-vine/issue/CAR-16/add-the-ability-for-any-user-to-add-their-own-openai-api-token) · Priority: High · Effort: Medium

Let any user paste their own OpenAI API key so their AI usage (drafts, transcript parsing, follow-up suggestions, extension profile parsing) bills to *their* OpenAI account instead of ours. Security-sensitive: encrypted at rest, never readable by the client, per-user routing with graceful fallback to the app key.

---

## 1. Security invariants (non-negotiable)

These are the rules every piece of the implementation must satisfy. Review the final PR against this list.

1. **The plaintext key exists only in three places, ever:** the user's paste (in-flight over TLS in a POST body), server memory during encrypt/decrypt/use, and OpenAI's servers. It is never written to disk, logs, error messages, Supabase rows (only ciphertext), or any API response.
2. **The browser can never read the key back.** The storage table has *no* RLS policies for the `authenticated` role — even `SELECT` is denied to the browser client. Only the service-role client (server-side) touches it. The GET endpoint returns metadata only (`hasKey`, `last4`, `status`).
3. **Ciphertext is useless without the server.** AES-256-GCM with a key that lives only in a Vercel/local env var (`BYOK_ENCRYPTION_KEY`), never in the database. A leaked DB dump reveals nothing.
4. **No key material in error paths.** Wrap all OpenAI errors before rethrowing; never interpolate the key into messages; never `console.log` the request config. Zod errors on the save endpoint must not echo the submitted value (use a custom message, not Zod's default which includes the received value for some checks).
5. **Fallback never silently strands the user.** If a user's key stops working we fall back to the app key *and* persist a status flag the UI surfaces — no invisible degradation, no hard failure mid-flow.
6. **Validation before storage.** A key is only saved after a live test call to OpenAI succeeds. No storing garbage.

---

## 2. Data model

New migration `supabase/migrations/20260708HHMMSS_create_user_api_keys.sql` (timestamp after `20260708113000_...`, the current latest):

```sql
CREATE TABLE user_api_keys (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'openai',
  encrypted_key text NOT NULL,          -- versioned ciphertext, see §3
  key_last4 text NOT NULL,              -- display only, e.g. "Ab3d"
  status text NOT NULL DEFAULT 'active' -- 'active' | 'invalid' | 'quota_exceeded'
    CHECK (status IN ('active', 'invalid', 'quota_exceeded')),
  last_validated_at timestamptz,        -- last successful test/real call
  last_used_at timestamptz,             -- last time routing chose this key
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policies for 'authenticated': the browser client can not
-- SELECT/INSERT/UPDATE/DELETE this table at all. All access goes through
-- API routes using the service client (same pattern as gmail_connections'
-- service-role policy, but stricter — not even metadata is client-readable).
CREATE POLICY "user_api_keys_service_role_all" ON user_api_keys
  FOR ALL USING (auth.role() = 'service_role');
```

Notes:
- `(user_id, provider)` PK future-proofs for Anthropic/etc. keys without schema change; all code hardcodes `provider = 'openai'` for now.
- `status` transitions: save → `active`; runtime 401 → `invalid`; runtime `insufficient_quota` → `quota_exceeded`; successful save or successful user-key call → back to `active`.
- Applied by Dawson locally via `supabase db push` per the usual workflow (rule 11).

---

## 3. Encryption design

App-layer **AES-256-GCM** via Node's built-in `crypto`. No new dependencies, no pg extensions (nothing in the repo uses pgsodium/vault, and Vault secrets don't fit the migration-only workflow).

**New file `careervine/src/lib/crypto.ts`:**

```ts
// BYOK_ENCRYPTION_KEY: 32 bytes, base64. Generate: openssl rand -base64 32
encryptSecret(plaintext: string): string   // -> "v1.<iv_b64>.<tag_b64>.<ciphertext_b64>"
decryptSecret(payload: string): string     // parses version, throws CryptoError on tamper/missing env
```

- Fresh random 12-byte IV per encryption; GCM auth tag stored alongside — tampering with ciphertext fails decryption loudly instead of yielding garbage.
- The `v1.` prefix makes future key rotation / algorithm migration a data migration, not a guessing game.
- `decryptSecret` failures (bad env key, corrupt row) are treated at call sites exactly like "no key": route to app key, mark row `invalid`. A bad `BYOK_ENCRYPTION_KEY` deploy must not take down AI features.
- **Rotation story (documented, not built):** to rotate, add `BYOK_ENCRYPTION_KEY_OLD`, decrypt-with-old → re-encrypt-with-new in a one-off script, then drop the old var. Out of scope for v1; the versioned format keeps the door open.

**Env var setup** (goes in the PR description + README deploy notes):
- Vercel: add `BYOK_ENCRYPTION_KEY` (production + preview).
- Local: add to `careervine/.env.local`.
- If unset: save endpoint returns a 500 with a clear server-log message; routing behaves as if no user keys exist. The app never crashes at import time over it.

---

## 4. Key resolution & routing

### 4.1 Library changes — `careervine/src/lib/openai.ts`

The current `getOpenAIClient()` caches **one process-wide client** built from `process.env.OPENAI_API_KEY`. That singleton is now wrong (one user's client must never be served to another). Replace with:

```ts
// Existing behavior, renamed conceptually: the app-owned client.
getAppOpenAIClient(): OpenAI                 // still cached module-level, env key

// New: per-user resolution.
type ResolvedOpenAI = {
  client: OpenAI;
  source: "user" | "app";
};
getOpenAIForUser(userId: string): Promise<ResolvedOpenAI>
```

`getOpenAIForUser`:
1. Look up the user's row in `user_api_keys` via the service client.
2. No row, or `status != 'active'`, or decryption fails → return app client (`source: "app"`).
3. Otherwise decrypt and return a client built with the user's key (`source: "user"`), and fire-and-forget update `last_used_at`.

**Caching:** small module-level `Map<userId, { key, expiresAt }>` with a **60-second TTL**, capped at ~500 entries (evict oldest). On Vercel each lambda instance has its own map — that's fine; the TTL bounds staleness after a key change to a minute, and the save/delete endpoints also clear the local map entry. Do *not* cache OpenAI client objects per user indefinitely (memory) — cache the decrypted key string briefly and construct clients cheaply.

### 4.2 Fallback policy — `runWithOpenAIFallback`

New helper in `openai.ts` that every call site routes through:

```ts
runWithOpenAIFallback<T>(
  userId: string,
  fn: (client: OpenAI) => Promise<T>
): Promise<T>
```

Behavior:
1. Resolve via `getOpenAIForUser(userId)`; run `fn(client)`.
2. If `source === "app"`: no special handling — errors propagate as today.
3. If `source === "user"` and the call fails with an **auth error (401 / `invalid_api_key`)**: mark the row `status = 'invalid'`, evict cache, **retry once with the app client**, return that result.
4. If `source === "user"` and the call fails with **`insufficient_quota` (429)**: mark `status = 'quota_exceeded'`, evict cache, retry once with the app client.
5. Any other error (rate limit without quota code, 5xx, network): propagate unchanged — these aren't key problems, and the app key would likely hit them too.
6. On a *successful* user-key call where the row was previously non-active (edge: races), leave status alone — status recovery happens through re-validation on save (§5) to keep runtime writes minimal.

Rationale for falling back on `insufficient_quota` (a real decision — it burns app credits): the product priority is that AI features never break mid-flow (UX-first, rule 5). The status flag + settings banner (§6) tells the user their key stopped covering usage; if app-side cost becomes a problem later, flip step 4 to hard-fail — it's one branch.

Error detection: match on `OpenAI.APIError` `status` + `code` fields from the official SDK (`error.status === 401`, `error.code === 'insufficient_quota'`) — no string matching on messages.

### 4.3 Call sites to update (all 11)

Every site currently does `const openai = getOpenAIClient()` then `openai.responses.create(...)` / `openai.chat.completions.create(...)`. Each becomes `runWithOpenAIFallback(user.id, (openai) => ...)`. All of them already have `user` in scope via `withApiHandler` (including the extension route via `extensionAuth`).

| Call site | Notes |
|---|---|
| `careervine/src/app/api/transcripts/parse/route.ts` | |
| `careervine/src/app/api/transcripts/match-speakers/route.ts` | |
| `careervine/src/app/api/transcripts/extract-actions/route.ts` | |
| `careervine/src/app/api/extension/parse-profile/route.ts` | extension auth path; `user.id` available |
| `careervine/src/app/api/ai/draft-intro/route.ts` | |
| `careervine/src/app/api/ai/draft-follow-ups/route.ts` | |
| `careervine/src/app/api/gmail/ai-write/route.ts` | two calls (body + subject) — wrap both in **one** `runWithOpenAIFallback` invocation so they use the same client |
| `careervine/src/lib/ai-followup/extract-interests.ts` | libs take `client: OpenAI` as a param instead of calling the factory; the orchestrating routes (`gmail/ai-followups/generate`, `suggestions/generate`) resolve once and pass it down. One resolution per request, not per helper. |
| `careervine/src/lib/ai-followup/find-article.ts` | same — thread client through `queryLLM` |
| `careervine/src/lib/ai-followup/generate-draft.ts` | same |
| `careervine/src/lib/ai-followup/generate-suggestions.ts` | same |

For the ai-followup orchestration routes, the fallback wrapper goes around the whole generation pipeline (resolve once → run all steps). If a user key dies mid-pipeline, the retry re-runs the pipeline on the app client — acceptable because these are idempotent generation flows.

`DEFAULT_MODEL` is unchanged — users bring a key, not a model choice. (Their free daily tokens via data-sharing cover the `gpt-5` family, which includes our `gpt-5-mini` default.)

**Deepgram (`transcripts/transcribe`) and Serper are untouched** — not OpenAI.

---

## 5. API surface

One resource route, `careervine/src/app/api/settings/openai-key/route.ts`, standard `withApiHandler` + service client + Zod schemas in `api-schemas.ts`:

### `GET` — status for the settings UI
```json
{ "hasKey": true, "last4": "Ab3d", "status": "active", "addedAt": "...", "lastUsedAt": "..." }
```
or `{ "hasKey": false }`. Never the key, never the ciphertext.

### `PUT` — save/replace key
Body: `{ "apiKey": string }`. Zod: trimmed, `min(20).max(200)`, must match `/^sk-/` (covers `sk-proj-...` too), custom error messages that don't echo input.

Server flow:
1. Validate format.
2. **Live-test the key**: `client.models.list()` with a 10s timeout — cheapest authenticated endpoint, zero token cost. 401 → respond `400 { error: "That key was rejected by OpenAI. Check that you copied the full key." }`. Network failure → `502` "Couldn't reach OpenAI to verify — try again."
3. Encrypt, upsert row (`status: 'active'`, `last_validated_at: now()`, `key_last4`: last 4 chars), evict routing cache for this user.
4. Respond with the same shape as GET.

### `DELETE` — remove key
Delete row, evict cache, `{ "hasKey": false }`. User falls back to the app key on their next AI action — features keep working.

No secrets in `queries.ts` (browser client) — this table is intentionally invisible to it (§1.2).

---

## 6. Settings UI

New section component `careervine/src/components/settings/ai-key-section.tsx`, registered as a new tab **"AI"** in the `tabs` array in `careervine/src/app/settings/page.tsx` (between Integrations and Availability). Follows the `templates-section.tsx` pattern: fetch on mount from the route, local state, `form-styles.ts` classes, inline saved/error feedback.

### Layout (top to bottom)

**1. Explainer header.** One short paragraph: *"CareerVine's AI features run on our shared key by default. Add your own OpenAI key to use your account instead — with OpenAI's free daily tokens, most people pay nothing."*

**2. 🎥 Video slot — "Watch: set up your key in 2 minutes".**
The card layout reserves this spot explicitly (per CAR-16 and this ticket's ask):

```tsx
// careervine/src/components/settings/ai-key-video.tsx
const SETUP_VIDEO_URL: string | null = null; // ← Dawson pastes the URL here after recording
```

- **Until the URL is set:** the component renders the written step-by-step instructions only (no broken embed, no placeholder box). Shipping isn't blocked on the recording.
- **Once set:** a responsive 16:9 embed above the steps.
  - If it's a **Loom URL** (ticket suggests Loom): `<iframe src="https://www.loom.com/embed/<id>">` in an `aspect-video` container. Zero hosting work, easy re-record.
  - If it's a **self-hosted mp4** (R2, `careervine/` prefix per the asset convention): native `<video controls preload="metadata" poster=...>`. The component branches on hostname.
- Recommendation: **Loom for v1** — fastest to record/replace, and the embed is free. Move to R2 only if Loom branding ever bothers you.

**3. Written steps** (always visible, numbered, with external links — also the video's script, see §7):
1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and sign in (or create an account — no payment method needed for free-tier usage).
2. Click **Create new secret key**, name it "CareerVine", leave permissions on **All**, create.
3. Copy the key immediately — OpenAI only shows it once.
4. *(For free daily tokens)* Go to **Settings → Data controls → Sharing** and turn on **"Share inputs and outputs with OpenAI"** — this gives your account up to 250k free tokens/day on the models CareerVine uses.
5. Paste the key below and hit Save.

**4. Key form / status card.** Three states:
- **No key:** password-type input (`autocomplete="off"`, monospace), Save button. On save: button shows "Verifying…" (the live test call), then success state.
- **Active key:** status card — green dot, `OpenAI key •••• Ab3d`, "Added <date>", "Last used <date>" when present, and a **Remove** button (`window.confirm`, matching settings conventions). No edit-in-place: replacing = paste a new key in the same input (PUT upserts). The input is never pre-filled with anything.
- **Problem key** (`status: 'invalid' | 'quota_exceeded'`): amber/red banner on the card — *"Your key was rejected by OpenAI / has run out of quota. We've switched you back to CareerVine's shared key. Paste a new key or check your OpenAI billing."* This is the surfacing end of the §4.2 fallback contract.

**5. Fine print** (small, muted): *"Your key is encrypted before it's stored and is never sent to your browser or anyone else. It's only used server-side to talk to OpenAI on your behalf. Remove it anytime."*

No toasts needed; inline `saved`/`error` state matches the other settings sections. Keep it visually quiet (rule 5 / UX-first).

---

## 7. The video — recording outline

Script for the ~2-minute recording (mirrors the written steps so they reinforce each other). Record at 1080p+, browser only, no tab clutter:

1. **(0:00)** Start on CareerVine → Settings → AI tab. "To use your own OpenAI account for CareerVine's AI features, you need an API key — here's the whole thing in two minutes."
2. **(0:15)** New tab → `platform.openai.com`. Show sign-in/sign-up briefly. Note: no credit card required for this.
3. **(0:35)** Navigate to **API keys** (left sidebar / settings) → **Create new secret key** → name it `CareerVine` → Create → **copy it now** ("OpenAI never shows it again — if you lose it, just make a new one").
4. **(1:05)** The free-tokens part: **Settings → Data controls → Sharing** → toggle on sharing inputs/outputs. "This opts you into OpenAI's free daily tokens — up to 250k tokens a day on the models CareerVine uses, which is far more than normal usage. If you'd rather not share data with OpenAI, skip this and add a few dollars of credit instead."
5. **(1:35)** Back to CareerVine → paste → Save → point out the "Verifying…" beat and the green `•••• Ab3d` card. "That's it — every AI feature now runs on your account. Remove it here anytime and you're back on the shared key."

After recording: paste the Loom share URL into `SETUP_VIDEO_URL` in `ai-key-video.tsx`, commit. (Before recording, double-check the current location/wording of OpenAI's sharing toggle and the free-token quota — OpenAI moves this stuff around.)

---

## 8. Tests (Vitest, `careervine/src/__tests__/`)

- **`crypto.test.ts`** — round-trip; unique IVs (two encryptions of same plaintext differ); tamper with ciphertext/tag → throws; missing/short env key → clear error; `v1.` format assertion.
- **`openai-key-route.test.ts`** (pattern: `api-handler.test.ts` mocking) —
  - GET: no row → `hasKey:false`; row → metadata only, assert response JSON **does not contain** the plaintext or ciphertext.
  - PUT: format rejection (no `sk-` prefix, too short); mocked `models.list` 401 → 400 without echoing the key; success → row upserted with ciphertext ≠ plaintext, `last4` correct.
  - DELETE: row gone, subsequent GET `hasKey:false`.
- **`openai-routing.test.ts`** — mock `user_api_keys` lookups + OpenAI client:
  - no row → app client used.
  - active row → user key used, `last_used_at` touched.
  - user-key 401 → one retry on app client, row marked `invalid`, result returned.
  - user-key `insufficient_quota` → retry on app client, row marked `quota_exceeded`.
  - user-key 500 → propagates, no fallback, status untouched.
  - cache: second resolve within TTL hits no second DB read; save/delete evicts.
- **`api-schemas.test.ts`** — add cases for the new key schema.
- Existing route tests for the 11 call sites: update mocks from `getOpenAIClient` to the new helper (`vi.mock("@/lib/openai")`).

Run `npm run test` in `careervine/` before every commit (rule 4).

---

## 9. Implementation order (each step = commit + push)

1. **Migration + crypto lib + tests** — `user_api_keys` migration, `crypto.ts`, `crypto.test.ts`. (Dawson: `supabase db push` after pulling.)
2. **Routing core** — `openai.ts` refactor (`getAppOpenAIClient`, `getOpenAIForUser`, `runWithOpenAIFallback`, cache) + `openai-routing.test.ts`. Nothing user-visible yet; call sites still on app client.
3. **API route** — `settings/openai-key/route.ts` + schemas + route tests.
4. **Call-site migration** — all 11 sites onto `runWithOpenAIFallback`; thread client through `ai-followup/` libs; update affected tests.
5. **Settings UI** — AI tab, `ai-key-section.tsx`, `ai-key-video.tsx` (URL `null`), states incl. problem-key banner.
6. **Docs** — README product blurb (rule 7): "Bring your own OpenAI key" under features; deploy note for `BYOK_ENCRYPTION_KEY`.
7. **Post-merge (Dawson):** add `BYOK_ENCRYPTION_KEY` to Vercel + `.env.local`, `supabase db push`, record the video, paste the Loom URL, commit.

## 10. Out of scope (v1)

- Key rotation tooling (format supports it; see §3).
- Per-user token metering/quotas — no precedent in the codebase; `last_used_at` is the only usage signal for now.
- Model selection per user, other providers (schema supports via `provider`).
- Admin dashboard of who's on BYO keys (query `user_api_keys` directly if curious).

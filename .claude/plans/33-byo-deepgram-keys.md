# 33 — BYO Deepgram API Keys (CAR-30)

**Linear:** [CAR-30](https://linear.app/career-vine/issue/CAR-30/add-the-ability-for-any-user-to-add-their-own-deepgram-api-key) · Priority: Medium · Effort: Medium
**Precursor:** [CAR-16](https://linear.app/career-vine/issue/CAR-16) / plan `29-byo-openai-keys.md` — read that first. This is a deliberate parallel and reuses its table, crypto, and routing pattern.

Let any user paste their own **Deepgram API key** so their audio/video **transcription** bills to *their* Deepgram account instead of ours. This is **additive** to the existing BYO OpenAI key — the two are independent and serve different jobs:

| Key | Powers | Provider |
| --- | --- | --- |
| OpenAI (`sk-…`) | Text AI: drafts, transcript *parsing*, follow-up suggestions | OpenAI |
| **Deepgram (this plan)** | Speech-to-text *transcription* of uploaded audio/video | Deepgram |

A user can set either, both, or neither; each independently falls back to CareerVine's shared key. **There is no provider switch** — they are not alternatives.

Why simpler than CAR-16: transcription has exactly **one call site**, and it already uses the Deepgram SDK (not OpenAI's Responses API), so there's no multi-site refactor and no API-shape change — just resolve a per-user key at one spot.

---

## 1. Security invariants (identical to CAR-16 — non-negotiable)

Carried over verbatim from plan 29 §1, "OpenAI" → "Deepgram", "OpenAI's servers" → "Deepgram's servers":

1. Plaintext key exists only in three places: the user's paste (TLS POST body), server memory during encrypt/decrypt/use, and Deepgram's servers. Never on disk, in logs, error messages, DB rows (ciphertext only), or any API response.
2. The browser can never read the key back. `user_api_keys` has no `authenticated`-role policy; the GET endpoint returns metadata only (`hasKey`, `last4`, `status`).
3. Ciphertext is useless without the server — AES-256-GCM, key only in `BYOK_ENCRYPTION_KEY` env.
4. No key material in error paths. Scrub Deepgram errors before rethrow; the Zod save-schema error must not echo the submitted value (custom message).
5. Fallback never silently strands the user — a failing user key falls back to the app Deepgram key **and** persists a status flag the UI surfaces.
6. Validation before storage — the key is saved only after a live test call to Deepgram succeeds.

**Review the final PR against this list**, same as CAR-16.

---

## 2. Data model — no new table

`user_api_keys` (from `20260709120000_create_user_api_keys.sql`) is already `PRIMARY KEY (user_id, provider)` with `provider text NOT NULL DEFAULT 'openai'`. Deepgram keys are simply rows with **`provider = 'deepgram'`**. Every existing column applies unchanged:

- `encrypted_key`, `key_last4`, `status` (`active | invalid | quota_exceeded`), `last_validated_at`, `last_used_at`.

**No migration needed** for storage. **No provider-preference column needed** either — unlike the (abandoned) Gemini idea, Deepgram isn't an alternative to OpenAI, so there's nothing to choose. The transcription feature always uses the Deepgram key (user's or app's); the text features always use OpenAI. Routing is by *feature*, which is already fixed in code.

---

## 3. Encryption — reuse as-is

No changes. `careervine/src/lib/crypto.ts` (`encryptSecret`/`decryptSecret`, versioned `v1.<iv>.<tag>.<ciphertext>`) and the existing `BYOK_ENCRYPTION_KEY` env var are provider-agnostic and cover Deepgram keys with zero modification.

---

## 4. Key resolution & routing — `careervine/src/lib/deepgram.ts` (new)

Mirror the shape of `openai.ts`, but the payload is a **key string + a Deepgram client**, not an OpenAI client. Deepgram's SDK client is cheap to construct, so we cache the decrypted **key string** (60s TTL) exactly like the OpenAI path and build `new DeepgramClient({ apiKey })` per call.

```ts
// careervine/src/lib/deepgram.ts
type ResolvedDeepgram = { apiKey: string; source: "user" | "app" };

getDeepgramKeyForUser(userId: string): Promise<ResolvedDeepgram>
```

`getDeepgramKeyForUser` — copy the logic from `getOpenAIForUser` (openai.ts ~199–243):
1. Look up `user_api_keys` for `(user_id, 'deepgram')` via the **service client** (wrap the whole lookup in try/catch — resolution is best-effort and must never take transcription down; the service-client constructor can throw if env is missing).
2. No row / `status='invalid'` / decrypt failure / any error → return the app key (`process.env.DEEPGRAM_API_KEY`, `source: "app"`).
3. `status='quota_exceeded'` within the cooldown window → app key. (Deepgram bills from a prepaid balance; "quota" here means "insufficient funds / rate limit." Consider a **longer** cooldown than OpenAI's 6h since a depleted Deepgram balance doesn't auto-reset daily the way OpenAI free tokens do — see §9 risks. A pragmatic choice: 24h, re-validated on next use.)
4. Otherwise decrypt, return the user's key (`source: "user"`), fire-and-forget `last_used_at`.

**Cache:** module-level `Map<userId, { key, expiresAt }>`, 60s TTL, ~500-entry cap — identical to the OpenAI cache but keyed only by userId (single provider here). Save/delete endpoints evict the entry.

**Fallback runner:**

```ts
runWithDeepgramFallback<T>(
  userId: string,
  fn: (client: DeepgramClient, source: "user" | "app") => Promise<T>,
): Promise<T>
```

- Resolve the user's key, build `new DeepgramClient({ apiKey })`, run `fn`.
- On a Deepgram **auth error** (HTTP 401 / invalid credentials) → mark `(user_id,'deepgram')` row `invalid`, rebuild with the app key, retry once.
- On **insufficient-funds / rate-limit** (Deepgram returns 402/429) → mark `quota_exceeded` (cooldown), retry with app key.
- Success on the user key → mark `active`, touch `last_used_at`.
- Status flips are always `UPDATE ... WHERE user_id=... AND provider='deepgram'`, **never upsert** (don't resurrect a deleted key — same rule as CAR-16 §2).
- **Verify Deepgram's error shape** against the installed `@deepgram/sdk` version — the SDK may surface errors as a `{ result, error }` tuple rather than throwing. Adjust `isAuthError`/`isQuotaError` accordingly (see §9).

Reuse the `markKeyStatus` / `scrub…` helpers from `openai.ts` by lifting the provider-agnostic ones into a shared `careervine/src/lib/byok.ts` if convenient — optional; a straight clone into `deepgram.ts` is acceptable given it's one provider.

---

## 5. Wire the single call site — `transcribe/route.ts`

`careervine/src/app/api/transcripts/transcribe/route.ts` today (lines 29, 58):

```ts
const apiKey = process.env.DEEPGRAM_API_KEY;          // line 29
if (!apiKey) throw new ApiError("Deepgram API key not configured", 500);
...
const deepgram = new DeepgramClient({ apiKey });      // line 58
result = await deepgram.listen.v1.media.transcribeUrl({ url, model: "nova-3", ... });
```

Change to route the actual transcription call through the fallback runner, so a bad **user** key silently degrades to the app key rather than failing the transcription:

```ts
const { segments, rawText } = await runWithDeepgramFallback(user.id, async (deepgram) => {
  const result = await deepgram.listen.v1.media.transcribeUrl({
    url: signedUrlResult.data.signedUrl,
    model: "nova-3", diarize: true, punctuate: true, smart_format: true, utterances: true,
  });
  // ...existing utterance→segment mapping and rawText build...
  return { segments, rawText };
});
```

Keep everything else (path ownership check, signed URL, meeting-ownership, `replace_transcript_segments` RPC, meeting update) exactly as is — only the client construction + the `transcribeUrl` call move inside the runner. `user.id` is already in scope via the `withApiHandler` context.

Edge case: if neither a user key nor `DEEPGRAM_API_KEY` is set, keep the existing clear 500 ("Deepgram API key not configured") — the runner should treat an empty app key as "no AI available," consistent with [CAR-26](https://linear.app/career-vine/issue/CAR-26)'s graceful-failure policy.

---

## 6. Settings CRUD route — `/api/settings/deepgram-key`

`careervine/src/app/api/settings/deepgram-key/route.ts` — clone `openai-key/route.ts`:

- **GET** → metadata only for the `deepgram` row (`hasKey`, `last4`, `status`, dates).
- **PUT** → in-memory rate-limit, `deepgramKeySaveSchema` validation, `validateDeepgramKey()` (§7), `encryptSecret`, upsert with `provider:"deepgram"`, `key_last4 = apiKey.slice(-4)`, `status:"active"`, evict cache.
- **DELETE** → delete the `deepgram` row, evict cache.

---

## 7. Validation

**Schema** — `careervine/src/lib/api-schemas.ts`, mirror `openaiKeySaveSchema`. Deepgram keys are **40-character lowercase hex** with **no fixed prefix** (unlike `sk-`/`AIza`), so validate on charset/length and lean on the live check:

```ts
export const deepgramKeySaveSchema = z.object({
  apiKey: z.string().trim()
    .regex(/^[0-9a-f]{40}$/, "That doesn't look like a Deepgram API key."),
});
```

> Confirm the exact format against a real key before locking the regex — if Deepgram has issued non-hex or variable-length keys, loosen to `.min(32).max(60)` + charset. Custom message so Zod never echoes the value (invariant #4).

**Live test** — `validateDeepgramKey(apiKey)`: the cheapest authenticated call that doesn't spend transcription credit. Options (pick per installed SDK):
- Management API **list projects** (`GET /v1/projects`) — returns 401 on a bad key, 200 on a good one, costs nothing. Preferred.
- Map 401 → 400 "That key was rejected by Deepgram." Map 402/quota → a funds message. Never surface the raw key.

---

## 8. Settings UI + instructions + video

Under **Settings → AI** (`careervine/src/app/settings/page.tsx`, the `"ai"` tab). Today it renders one `<AiKeySection />` (OpenAI). Add a **second, independent card** for Deepgram below it — both always visible (no toggle).

Cleanest approach (rule 5 — no clutter, one shared implementation):
- Factor the OpenAI card body into a reusable `<ProviderKeyCard provider="openai" | "deepgram" />` that takes provider-specific props: label, input placeholder (`sk-…` vs a 40-hex example), endpoint base (`/api/settings/openai-key` vs `/api/settings/deepgram-key`), and instructional copy. Status badges (active/invalid/quota), save/remove flow, and last4 display are shared.
- If factoring is too invasive for one PR, a straight clone `deepgram-key-section.tsx` is acceptable — but prefer the shared component.

**Instructions copy (Deepgram card):**
- What it's for: "Transcribe your meeting recordings using your own Deepgram account."
- Where to get a key: link to [console.deepgram.com](https://console.deepgram.com) → API Keys; note Deepgram's free credit (currently $200) so it reads as low-friction.
- Honest data note: audio is sent to Deepgram for processing (mirrors the OpenAI card's data disclosure).

**Video slot** — the user explicitly wants a place for a how-to video. `ai-key-video.tsx` currently hardcodes `SETUP_VIDEO_URL = null` and an OpenAI title, rendering nothing until a URL is pasted. Parameterize it per provider (or add a sibling `deepgram-key-video.tsx`) with its own `SETUP_VIDEO_URL: string | null = null` default. It renders nothing until Dawson records and pastes a Loom/self-hosted URL — same pattern as OpenAI, no dead UI in the meantime.

---

## 9. Tests (mirror CAR-16's suite)

Under `careervine/src/__tests__/`:
- **`deepgram-routing.test.ts`** (clone `openai-routing.test.ts`) — user-vs-app resolution for `provider='deepgram'`, 401→invalid→app-key fallback, funds/quota→cooldown, cache TTL/eviction, `markKeyStatus`. Set `DEEPGRAM_API_KEY` + `BYOK_ENCRYPTION_KEY` in setup.
- **`deepgram-key-route.test.ts`** (clone `openai-key-route.test.ts`) — GET/PUT/DELETE, encryption round-trip, rate-limit, `validateDeepgramKey` 401→rejected mapping.
- **`api-schemas.test.ts`** — add `deepgramKeySaveSchema` cases (accepts a 40-hex string, rejects `sk-…`, rejects wrong length, echo-free error).
- **transcribe route test** — assert it routes through `runWithDeepgramFallback` and that a mocked user-key 401 retries with the app key and returns segments (mirror `transcripts-parse-byo.test.ts`).

Run `npm run test` from `careervine/` and confirm green before commit (rule 4).

---

## 10. Privacy & docs

- **`careervine/src/app/privacy/page.tsx`** — Deepgram already processes uploaded audio, so it should already be disclosed; confirm it's named and add a line that users may supply their own Deepgram key. Keep it factual.
- **README** — product-framed (rule 7): users can now bring their own **Deepgram** key for transcription *and* their own OpenAI key for text AI — describe the value (control your own AI spend / limits), not the wiring.

---

## 11. Build order (suggested PR slices)

1. **Lib** — `careervine/src/lib/deepgram.ts` (`getDeepgramKeyForUser` + `runWithDeepgramFallback`), unit-tested against mocked `user_api_keys`. No behavior change yet.
2. **Wire transcribe** — route the one call site through the runner; verify existing transcription still works on the app key.
3. **Settings route + schema + validation** — `/api/settings/deepgram-key`, `deepgramKeySaveSchema`, `validateDeepgramKey`.
4. **UI** — `<ProviderKeyCard>` refactor (or clone) + Deepgram card + video slot + instructions.
5. **Tests + privacy + README.**

Slices 1–2 are provider-plumbing with the app key still in effect, so they're safe to land and verify before any user-facing key entry exists.

---

## 12. Risks / verify during build

- **Deepgram SDK error contract** — `@deepgram/sdk` may return `{ result, error }` rather than throwing (the current route wraps `transcribeUrl` in try/catch and logs `dgError`). Confirm whether auth failures throw or return an `error` object, and make `isAuthError`/`isQuotaError` handle whichever it is. This is the single most important thing to get right for the fallback to work.
- **Validation endpoint** — confirm the management "list projects" call works with the installed SDK version and a scoped key; some Deepgram keys are project-scoped and may not list projects. A tiny no-op transcription is a fallback validation but costs credit — avoid if possible.
- **Quota semantics** — Deepgram "quota" = prepaid balance / rate limit, which doesn't reset daily like OpenAI free tokens. Don't reuse the 6h cooldown blindly; a depleted balance staying flagged for 24h (re-checked on next use) is more honest than repeatedly retrying a broke key.
- **Key format** — verify the `^[0-9a-f]{40}$` assumption against a real current Deepgram key before shipping the regex; loosen if needed.
- **`last4` of a hex key** — fine to display, but low entropy; it's display-only and never used for auth, so acceptable (same as OpenAI last4).

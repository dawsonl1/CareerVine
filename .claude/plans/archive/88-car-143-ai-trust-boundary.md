# CAR-143 — Seal the AI generation trust boundary

Wave 2 · T6 of the Straight A's program (CAR-28). Retires R5.1–R5.4: CRLF-proof
email headers, uniform HTML sanitization on every AI output path, prompt
delimiting for untrusted input, a persisted shared-key spend ceiling, and JSON
parse guards.

## 1. R5.1 — Header injection (CRLF) hardening

**`careervine/src/lib/gmail.ts` (buildMimeMessage region only):**
- Add `sanitizeHeaderValue(value)`: strips `\r` and `\n` (and other C0 control
  chars) from every interpolated header value.
- Add RFC 2047 B-encoding for non-ASCII subjects (`=?UTF-8?B?…?=`).
- Apply to from, to, cc, bcc, subject, in-reply-to, references in
  `buildMimeMessage`.

**Zod entry-point guards** — shared `headerSafeString` primitive with
`.regex(/^[^\r\n]*$/)`:
- `api-schemas.ts`: gmailSendSchema (to/subject/cc/bcc/inReplyTo/references),
  gmailDraftSchema, followUpMessageSchema.subject, gmailScheduleCreateSchema,
  gmailScheduleUpdateSchema, gmailAiWriteSchema.subject/recipientEmail.
- `email-follow-ups/route.ts` createFollowUpsSchema: recipientEmail + subject
  fields.
- `src/mcp/tools/email.ts`: composeShape.subject/to_email and
  followUpSequenceSchema message subjects (MCP args come straight from an LLM).

**AI subject line**: strip interior CR/LF on the generated subject in
`generate-draft.ts` (and the ai-write generated subject).

**Test**: subject containing `\r\nBcc: attacker@evil.com` through
buildMimeMessage yields exactly one Subject header and zero Bcc in the decoded
raw message; zod rejects CRLF on web and MCP schemas; non-ASCII subject gets
RFC 2047 encoded.

## 2. R5.2 output half — uniform HTML sanitization

New `careervine/src/lib/ai/sanitize-email-html.ts` (single JSDOM+DOMPurify
instance) with two profiles:
- `sanitizeAiDraftHtml` — tight allowlist (p/br/a/strong/em/b/i +
  href/target/rel), extracted from generate-draft.ts.
- `sanitizeStoredEmailHtml` — broader email-safe profile (standard HTML
  profile; strips script/style/forms/event handlers/javascript: hrefs).

Apply tight profile on every AI generation return:
- `gmail/ai-write/route.ts` (bodyHtml)
- `ai/draft-intro/route.ts` (bodyHtml)
- `ai/draft-follow-ups/route.ts` (each follow-up bodyHtml)
- `ai-followup/generate-draft.ts` (switch to shared helper)

Apply broader profile at the storage chokepoints the cron auto-sends from:
- `email-follow-ups/route.ts` POST (body_html per message)
- `gmail/follow-ups/route.ts` POST (message bodyHtml before
  buildFollowUpMessageRows)
- `gmail/follow-ups/[id]/route.ts` PUT (same table, same cron)

**Test**: script-tag/onerror/javascript:-href inputs are stripped by both
profiles; a script-tag POST to email-follow-ups stores sanitized body_html.

## 3. R5.2 input half — prompt delimiting for untrusted content

New `careervine/src/lib/ai/untrusted.ts`:
- `wrapUntrusted(tag, text)` — XML-style fencing; escapes literal closing tags
  so content can't break out of the fence.
- `UNTRUSTED_DATA_CLAUSE` — system-prompt constant declaring fenced content is
  data, never instructions.

Route every raw interpolation of untrusted content through `wrapUntrusted`:
- `gather-context.ts` formatContextForLLM: contact notes, meeting notes,
  transcript excerpts, interaction summaries.
- `ai-helpers.ts` getContactContext: contact notes, meeting notes, transcripts.
- `generate-draft.ts` buildDraftPrompt: interest evidence/topic + article title
  (Serper-sourced).
- `find-article.ts` buildEvalPrompt: interest evidence + Serper
  title/snippet/source.
- `api/extension/parse-profile/route.ts`: the LinkedIn page text.
- Route-level untrusted spans in ai-write / draft-intro / draft-follow-ups
  (contact info, meeting notes, prior email body).

Add `UNTRUSTED_DATA_CLAUSE` to each consumer's system prompt: extract-interests,
generate-draft, find-article eval, ai-write, draft-intro, draft-follow-ups,
parse-profile.

**Test**: wrapUntrusted escapes embedded closing tags; snapshot one hardened
prompt per pure builder (formatContextForLLM, buildDraftPrompt,
buildEvalPrompt).

## 4. R5.3 — Shared-key spend ceiling (+ migration, + rate-limit fail-closed)

**Migration** `supabase/migrations/20260717…_car143_ai_shared_spend.sql`:
- Table `ai_shared_usage` (user_id, period_start date, estimated_cost_usd
  numeric, call_count int, updated_at; PK (user_id, period_start)). RLS
  service-only (deny all to anon/authenticated).
- RPC `increment_ai_shared_usage(p_user_id, p_period_start, p_cost)` — atomic
  upsert-add.
- Applied per rule 27 after merge.

**`careervine/src/lib/ai/spend.ts`** (modeled on `apify/spend.ts` fail-closed
style):
- `getSharedAiSpendUsd(userId)` — current-month row read; throws on error.
- `recordSharedAiSpend(userId, costUsd)` — fire-and-forget RPC increment.
- `estimateCallCostUsd(result)` — token-usage-based estimate when the response
  carries `usage`, conservative flat fallback otherwise.
- `SHARED_AI_SPEND_LIMIT_USD` — small monthly ceiling, env-overridable.

**`careervine/src/lib/openai.ts`** chokepoint:
- Before every shared-key call (both `resolveWithoutPersonalKey` grant path and
  `fallbackToSharedOrFail`), check the ceiling. Over threshold — or spend
  lookup error (fail closed, matching resolveSharedAccess) — resolves to the
  trial-expiry UX (`ai_trial_expired`) instead of reaching the shared key.
- After every successful shared-key call, record estimated spend.
- BYO-key users never touch this path.

**`careervine/src/lib/rate-limit.ts`**: add `failClosed` option — in production,
missing Upstash env or a limiter error denies instead of allowing. Set it on
the AI buckets (ai-write, draft-intro, draft-follow-ups, ai-followups/generate,
parse-profile).

**Test**: a user at the spend threshold gets AiUnavailableError(ai_trial_expired)
with zero OpenAI calls; below-threshold proceeds and records; spend lookup error
fails closed; rate-limit failClosed denies in production without Redis and
still allows in dev.

## 5. R5.4 — JSON guards

- `extract-interests.ts`: validate parsed shape — non-array
  interests/profileFallbacks degrade to `[]`, never throw on `.sort`.
- `find-article.ts`: wrap the bare `JSON.parse` at evaluateArticle — malformed
  content means "skip", not a thrown 500.
- Shared `parseModelJson` helper in `src/lib/ai/model-json.ts` used by both.

**Test** (first tests for extract-interests): valid-JSON-wrong-shape degrades to
empty results; malformed eval JSON skips the article.

## Exit criteria (from the ticket)

- CRLF-laced subject/recipient produces no injected header; zod rejects CRLF on
  web and MCP entry points.
- Zero AI routes return raw model HTML; a script-tag POST to email-follow-ups
  stores sanitized body_html.
- All raw interpolations route through wrapUntrusted; every AI system prompt
  carries the clause.
- A user at the spend threshold gets a clean exhausted response instead of a
  shared-key call; no AI route reaches the shared key without the counter.

## Delivery

Branch `dawson/car-143-impl-review-12d000` (this worktree). Full test suite +
build before PR. After the PR opens, run /deep-review-pr and fix every verified
finding (including nits) inside this PR. Migration applied via
`supabase db push` (dry-run first) after merge, per rule 27.

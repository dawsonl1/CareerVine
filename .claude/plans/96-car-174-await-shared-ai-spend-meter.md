# CAR-174: Shared-key AI spend meter must not be a bare floating promise

## Problem

`careervine/src/lib/openai.ts` records shared-key spend at its two metering
sites (`runWithOpenAIFallback` shared path, `fallbackToSharedOrFail`) as
`void recordSharedAiSpend(...)` — a bare floating promise. Vercel can freeze
the invocation the moment the response is sent (the exact behavior
CAR-153 documented in `gmail/emails/route.ts`), so the increment is lost
intermittently and `getSharedAiSpendUsd` undercounts. The fail-closed ceiling
checked before every shared-key call then never trips: the shared OpenAI key
(Dawson's personal key) has no effective spend cap.

## Decision: await, don't waitUntil

The ticket offers `waitUntil` (CAR-153 precedent) or awaiting. **Await** is
the right call here:

- The meter is a **control, not telemetry** — a ceiling that can be skipped
  for latency is not a ceiling.
- `recordSharedAiSpend` never throws (it catches and logs internally), so
  awaiting cannot break the caller's success path.
- The cost is one small RPC on a path that just awaited an OpenAI round trip
  — negligible.
- `openai.ts` is lib code, not route code; importing `@vercel/functions`
  there couples the data layer to the deploy platform, and `waitUntil` still
  only *requests* survival — await is deterministic.

`void markKeyStatus(...)` sites stay as they are: key-status writes are
genuinely best-effort telemetry, self-healing on the next call.

## Changes

1. **`careervine/src/lib/openai.ts`** — both metering sites become
   `await recordSharedAiSpend(userId, estimateCallCostUsd(result))`, with
   comments updated to state why the await is load-bearing (CAR-174).

2. **Convention guard** — `eslint.config.mjs`: add a `no-restricted-syntax`
   selector forbidding `void recordSharedAiSpend(...)`
   (`UnaryExpression[operator='void'] > CallExpression[callee.name='recordSharedAiSpend']`),
   present in **both** the src-wide rules and the MCP block's existing
   `no-restricted-syntax` list (flat config: last matching block wins per
   rule, so the selector must ride along in the MCP block or MCP files lose
   it). Shared as a single const so the two blocks can't drift.

3. **Tests**
   - `openai-routing.test.ts`: replace the "let the microtask settle"
     setTimeout dance with direct assertions, and add a **deferred-resolve
     regression test**: mock the increment RPC with a promise we control,
     assert `runWithOpenAIFallback` has NOT resolved while the meter write is
     pending, then release it. Reverting to `void` fails this test. Cover the
     `fallbackToSharedOrFail` path the same way.
   - `eslint-guardrails.test.ts`: `void recordSharedAiSpend(...)` is
     restricted in `src/lib/**` and `src/mcp/**`; `await` form is clean.

## Already verified (no code change needed)

- **Concurrency**: `increment_ai_shared_usage` (migration
  `20260717010000_car143_ai_shared_spend.sql`) is an atomic
  `INSERT ... ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x` — concurrent
  calls cannot lose increments.
- **Coverage of call sites**: no route calls `getAppOpenAIClient` directly;
  every shared-key call flows through `runWithOpenAIFallback` /
  `fallbackToSharedOrFail`, and both consult `checkSharedSpendBudget`
  fail-closed before calling.

## Verification

- `npm run test` + `npm run lint` from `careervine/` (guardrail suite lints
  against the real config).
- Ceiling-refusal behavior is already pinned by existing tests
  ("blocks the user-key→shared fallback when over the ceiling", exhausted /
  unknown budget paths in `getOpenAIForUser`).
- Post-merge: empirical RPC round-trip against production (synthetic row:
  increment via RPC, read back, delete) to prove the meter mechanics live,
  per rule 39's test-don't-assume posture.

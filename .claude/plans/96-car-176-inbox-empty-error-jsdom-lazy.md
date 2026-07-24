# CAR-176: Empty inbox renders as an error + jsdom loads eagerly in the MCP bundle

Two small regressions from the Straight A's program, found by the CAR-28 post-program verification. Both low severity, unrelated files, one branch.

## Fix 1 — inbox: transient refresh failure over an empty mailbox wipes the page

CAR-154 gave the dashboard a `coreLoadedOnce` gate but the inbox arm never got it. Repro: Gmail-connected user with a legitimately empty mailbox sends an email; the `emailSent` refresh fails once (500 / `success:false`); `anyInboxData` is false and `loading` is false, so `inbox-shell.tsx` replaces the whole working page with the full-screen `LoadErrorState`.

**Changes:**

- `careervine/src/components/email/inbox/use-inbox-data.ts`: add `loadedOnce` state, set true the first time `loadInbox` succeeds (`data.success`). Expose it.
- `careervine/src/components/email/inbox/inbox-shell.tsx`:
  - Gate the full-screen error on `!loadedOnce`: `if (loadError && !loading && !anyInboxData && !loadedOnce)`. First-load failures keep today's behavior exactly.
  - Add an effect that fires a `toastError` when a refresh fails after a successful load and there is no data on screen for the existing `LoadErrorBanner` to attach to (`loadError && !loading && loadedOnce && !anyInboxData`). The known-good empty state stays on screen; the failure surfaces as a toast, matching the house pattern for failed background operations (F21 rollback toasts).
  - The partial-failure banner (`anyInboxData` true) is untouched.

**Tests** (`src/__tests__/inbox-shell.test.tsx`, existing CAR-154 describe block):
- Empty successful load, then a failed refresh → page keeps the empty state (no `LoadErrorState`), toast fired.
- First load fails → full-screen retryable error (existing behavior, should still pass).

## Fix 2 — sanitize-email-html: jsdom paid on every MCP cold start

`sanitize-email-html.ts` runs `new JSDOM("").window` + `createDOMPurify` at module top level; `src/mcp/tools/email.ts` imports it and `/api/mcp/route.ts` reaches it eagerly via `registerAllTools`. Measured ~128ms require + ~23ms construct of pure cold-start CPU on the highest-traffic route. The require cost dominates, so the fix must defer the module load itself, not just the construction.

**Changes** (`careervine/src/lib/ai/sanitize-email-html.ts`):

- Replace the top-level `import { JSDOM } from "jsdom"` + eager construction with a memoized `getPurify()` that does a lazy `require("jsdom")` and constructs the JSDOM window + DOMPurify instance on first sanitize call. Both profile functions call `getPurify()`; signatures stay sync, so no consumer changes.
- Lazy `require` is safe on all three runtimes in play: webpack bundles and defers a literal `require()` in server code (statically analyzable, so nft tracing keeps jsdom in the bundle); Vitest's transform supports it (verified empirically in this worktree before writing this plan); and the rule-43 CJS constraint is unchanged — `serverless-require-safety.test.ts` still guards the exact chain in a child process with `require(esm)` disabled.
- Preserve the rule-43 comment pinning jsdom ^26.1.0 and the `as any` cast rationale.

**Tests:**
- Existing `src/__tests__/sanitize-email-html.test.ts` and `src/mcp/__tests__/email-body-sanitize.test.ts` must pass unchanged (CAR-143 security properties pinned).
- New test: `vi.mock("jsdom")` with a counting constructor — importing the module constructs nothing; first sanitize call constructs exactly once; second call reuses it.

## Verification

- `npm run test` from `careervine/` — full suite green.
- `npm run build` — confirms webpack handles the lazy require (and typed lint per rule 48: run lint/tsc with `.next` moved aside if anything looks off).
- CAR-143 security tests unchanged and green.

## Rollout

Standard worktree flow: PR with `(CAR-176)`, no migrations, no docs/copy impact (no user-visible behavior change beyond the error-state fix, which the docs page does not describe).

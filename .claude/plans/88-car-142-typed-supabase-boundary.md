# CAR-142 — Typed Supabase boundary: `<Database>` on all four factories, generated types, schema-drift CI gates

**Wave 2 · T5 · Straight A's (CAR-28). Retires F3, F30. Blocked by CAR-138 (CI, merged).**

## Goal

Make a column rename a **compile error**, not a runtime `undefined`. Today none of the four Supabase client factories is parameterized, so every `.from().select()` returns effectively `any`, and `database.types.ts` is 34 migrations stale (missing `analytics_events`, `user_milestones`, and ~30 other tables/views that exist in production). CAR-138 planted **97 `CAR-142` eslint-disable markers** at the `any`/cast sites created by this untyped boundary; this ticket burns them down.

## Type-generation strategy (the core decision)

Three candidate schema sources: production (Management API), the migration chain (local stack), a shadow DB. Decision:

- **Committed `database.types.ts` is generated from the migration chain** (`supabase gen types typescript --local`, all 91 migrations applied to a fresh local Postgres). This is what CI can reproduce deterministically with no production secret, so the "migration PR without regenerated types goes red" gate works.
- **CI regenerates from the same migration chain** (pinned CLI version → byte-identical) and diffs against the committed file.
- **Production drift is a separate concern**: a tripwire script runs `supabase db diff --linked` (migration chain vs the real production DB) and fails on divergence. After reconciliation, migration-chain types == production types, so the source choice is moot — but the tripwire keeps them that way going forward. Rule 12/rule 32 history (lost migrations, prod-only columns) is exactly why this exists.

Local generation uses an **isolated `careervine` stack on offset ports** (54341/54342/…) so it never disturbs a developer's default-port stack; `supabase/config.toml` is committed with **default** ports.

## Work

### 1. Non-destructive types file (task #1)
- New `src/lib/app-types.ts` ← move `OnboardingState`, `ExtensionOnboardingState` (currently hand-authored at `database.types.ts:21-46`).
- Per-column prose comments → a schema-notes doc under `supabase/database-reference/`.
- Regenerate `database.types.ts` from the migration chain. Re-point every importer of the moved types (`@/lib/database.types` → `@/lib/app-types`).
- Commit `supabase/config.toml` (default ports) so `gen:types`/CI are reproducible.

### 2. Reconcile production drift (task #2)
- Confirm all 91 migrations apply to a clean DB (validates the chain; rule 32).
- Diff migration-chain schema vs production. Reconcile any divergence into **catch-up migrations** (never ad-hoc SQL — rule 10).
- Replace the 88-migrations-stale `supabase/database-reference/starting_database.md` with a current schema snapshot.

### 3. Parameterize the four factories (task #3) — order matters
1. `src/lib/supabase/service-client.ts` — least-supervised writes (crons + MCP) first.
2. `src/lib/supabase/server-client.ts`
3. `src/lib/supabase/browser-client.ts`
4. `src/lib/extension-auth.ts` — parameterize both the bearer-path `createClient` and type the return `SupabaseClient<Database>`.

Fix tsc fallout **per factory** (`npx tsc --noEmit` after each). Delete `as unknown as` join casts and `as any` query-site casts where typed select-string inference now supplies the shape (biggest clusters: `queries.ts`, `company-queries.ts`, `mcp/lib/db.ts`, `contact-employment.ts`'s `{ from: (table: string) => any }`, `send-follow-ups`' `(msgs[0] as any).email_follow_ups.user_id`). Remove the paired `CAR-142` eslint-disable markers as each `any` is resolved.

**Where Supabase's relationship inference genuinely differs from reality** (e.g. a to-one embed it infers as an array), keep a narrow, honestly-commented cast rather than forcing a wrong shape — the goal is *net reduction of untyped-client debt*, not zero casts.

**File-ownership boundary (this wave):** do **not** restructure `src/lib/ai-followup/*` or `gmail.ts` — the AI-boundary ticket owns them. Touch them only for mechanical cast deletions needed to keep tsc green.

### 4. gen:types script + CI drift job + prod tripwire (task #4)
- `gen:types` npm script (materializes the migration chain, runs `supabase gen types`, writes `src/lib/database.types.ts`).
- CI job in `.github/workflows/ci.yml`: stand up the migration chain, regenerate, `git diff --exit-code` the types file → red on drift. Pin the CLI version to match local for byte-identical output.
- Drift-probe script (peer of `scripts/qstash-schedules.mjs`) running `supabase db diff --linked`, non-zero on divergence; wired as a **pre-flight** into `scripts/supabase-prod-push.sh` so a push refuses when prod has drifted.

### 5. Verify + PR + deep-review (task #5)
- `npm run test`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx next build` — all green.
- Document the `as any` / `as unknown as` delta in the PR body (both strictly down).
- PR titled `… (CAR-142)`. Then `/deep-review-pr`, fix **every** verified finding incl. nits in this same PR/ticket.

## Exit criteria (from ticket)
- `rg 'createClient<|createBrowserClient<|createServerClient<'` shows all four factories parameterized.
- `database.types.ts` byte-identical to `gen:types` output; contains `analytics_events` + `user_milestones`; tsc green in CI.
- A deliberately stale types file turns the CI drift job red; `supabase-prod-push.sh` refuses to push when the drift probe fails.
- Non-test `as unknown as` < 48 and `as any` < 41, both strictly below the working baseline, tracked in the PR body.

## Working baseline (measured on this branch, non-test src)
- `as any`: 30 · `as unknown as`: 48 · `CAR-142` markers: 97

## Update (post-merge)
- The "91 migrations" figures above were accurate at plan time. Merging `main` brought CAR-143's `20260717010000_car143_ai_shared_spend.sql`, so the chain is now **92 migrations**; `database.types.ts` was regenerated to include `ai_shared_usage` + `increment_ai_shared_usage`.
- The offset ports (54341/54342) were only a temporary local-coexistence detail while another stack held the defaults. The committed `supabase/config.toml` and the CI `types-drift` job both use the **default** ports (54321/54322); the reproducible path never depends on the offset ports.
- Final non-test cast counts: `as any` 30 → **21**, `as unknown as` 48 → **28** (both under the exit targets, strictly down).

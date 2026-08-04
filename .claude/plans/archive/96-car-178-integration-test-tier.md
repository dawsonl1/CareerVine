# CAR-178: Integration test tier against real Postgres + PostgREST + RLS

## Problem

No test tier executes mutation logic against a real database. All 28 Supabase-touching
test files use hand-rolled builder mocks, which structurally cannot catch: RLS policy
defects (CAR-159's original one-leg policy), PostgREST representation semantics
(rule 17/39), CHECK-constraint drift (rule 40), cascade behavior, or query-shape
changes behind shared reads.

## Approach

New, separate vitest project that talks to the **local Supabase stack** (the same one
CI's `types-drift` job already boots at the full migration chain). It never runs in the
fast unit suite.

### 1. Harness (`careervine/src/__integration__/`)

- **File naming**: `*.itest.ts` so the main vitest config (`src/**/*.test.ts`) never
  picks them up. New `vitest.integration.config.ts` includes only `src/**/*.itest.ts`;
  npm script `test:integration`.
- **Stack resolution** (globalSetup): shell `supabase status -o env` from the repo root
  to get `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL`. Fail with a clear
  "run `supabase start`" message if the stack is down. Also export the env vars
  `createSupabaseServiceClient()` reads, so app code under test constructs real local
  clients when invoked without injection.
- **Clients**: service client (service key), plus two RLS-scoped tenants — created via
  `auth.admin.createUser({ email_confirm: true })` + `signInWithPassword` on an anon
  client. The `on_auth_user_created` trigger gives each a `public.users` row
  (status 'active', so cron paths see them).
- **Direct SQL**: `pg` (devDependency) pool against `DB_URL` for what PostgREST can't
  express: information_schema/pg_catalog censuses, constraint introspection, and
  cleanup. Test-code only; app code never touches it.
- **Fixture builder**: seeds a full tenant graph per user (contact + emails, company,
  email_message, junction rows, meeting, scheduled_email, follow_up + messages, etc.)
  and records every inserted row as `(table, pkFilter)` so cascade and isolation tests
  can enumerate exactly what must disappear / be invisible.
- **Isolation between test files**: each file seeds its own users (unique emails) and
  deletes them in afterAll; no shared mutable fixtures across files.

### 2. Tenant isolation (`rls-tenant-isolation.itest.ts`)

For **every table with a user-scoped RLS policy**: seed a row for user B (service
client), then as user A assert:
- SELECT returns zero rows,
- UPDATE / DELETE affect zero rows (`count: "exact"`),
- INSERT referencing B's parent rows is refused (WITH CHECK / policy violation).

Driven by a per-table **factory registry** (minimal valid insert payload given a tenant
fixture). A **completeness guard** queries `pg_policies`/`pg_class` for all RLS-enabled
tables and fails if any table is missing from the registry — a new table cannot ship
without an isolation case. Tables that are deliberately not user-scoped (service-role
only, shared/public read like published bundles) go in an explicit annotated exemption
map, same pattern as `HAND_ROLLED`.

This directly complements the MCP scoping gate, which documents it is *not* a tenant
isolation proof. The CAR-159 both-legs policy gets a dedicated case: user A attempting
to link their own message to B's contact must be refused.

### 3. Money path (`scheduled-send.itest.ts`)

Real `processScheduledEmails` / `processDueScheduledEmails` with the **real local
service client** injected and only the Gmail `send` faked:
- happy path: pending → sending → sent, `sent_at`/`gmail_message_id` stamped, linked
  `email_follow_ups` updated;
- **concurrent-claim race**: two drivers race the same due row (deferred send fake);
  exactly one Gmail send happens — the rule-17 CAS count pattern proven against real
  PostgREST;
- post-send failure window: driver dies after send (fake throws after resolving) → row
  stays 'sending', sweeper flags 'failed', never re-queued;
- SendPolicyError release: claim released back to 'pending' (bounce), batch stop on 429;
- stale-claim sweep for follow-ups: the `!inner` parent-status split
  (active → awaiting_review with CAR-105 stamp, dead parent → cancelled) exercised as
  the same query shapes the cron uses;
- **cross-tenant guard**: a due row for user B must be untouched when processing user A
  (this is what goes red when a `user_id` filter is dropped).

### 4. Constraint conformance (`check-constraints.itest.ts`)

Introspect every CHECK constraint via `pg_get_constraintdef` and assert each
constants.ts vocabulary (`ScheduledEmailStatus`, `FollowUpStatus`,
`FollowUpMessageStatus`, `AiFollowUpDraftStatus`, …) is a **subset of the live allowed
set** for its table+column. Plus write-path proof: insert/update each app-written status
value through PostgREST and expect acceptance. Catches rule 40 mechanically in both
directions (enum value the CHECK forbids ⇒ red).

### 5. Deletion cascade (`user-deletion-cascade.itest.ts`)

Seed the full fixture for a user, `auth.admin.deleteUser`, then assert **every recorded
row is gone** (exact pkFilter probes via service client / pg), plus a census: every
table with a `user_id` column has zero rows for the deleted id. The two deliberate
non-cascades (`admin_audit_log.updated_by` SET NULL) are asserted as SET NULL, not
absence.

### 6. CI (`integration` job in ci.yml)

Mirrors `types-drift`: pinned supabase CLI 2.109.1, same `supabase start -x …` exclusion
list, `npm ci` in careervine, `npm run test:integration`. Runs on every PR; separate job
so the fast suite stays fast. Also update CONVENTIONS.md §h (tests) with the new tier
and how to run it locally.

## Explicitly out of scope

No porting of mocked tests. The mocked suite stays authoritative for logic; this tier is
only for semantics mocks cannot express.

## Verification (ticket's four injected defects — each must go red)

1. RLS leg removed from `email_message_contacts` policy (psql on local stack) →
   isolation suite red; `supabase db reset` restores.
2. Status value the CHECK forbids (narrow the CHECK locally) → conformance suite red.
3. `user_id` filter removed from `processScheduledEmails`'s pending query (temporary
   code edit) → cross-tenant money-path case red.
4. `ON DELETE CASCADE` dropped from `email_message_contacts` FK (psql) → cascade suite
   red.

Results of all four recorded in the PR body. Standard exit: tests + lint + typecheck
green, PR with `(CAR-178)`, stop at PR.

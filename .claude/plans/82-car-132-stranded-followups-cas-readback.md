# CAR-132 — Fix stranded premium auto-send follow-ups (rule-17 CAS read-back bug)

Audit finding F1 (critical, live in production) from the 2026-07-16 re-audit (CAR-28).

## Empirical result: the ticket's premise is DISPROVEN

The ticket asked for a real PostgREST behavior test because two audit verifiers
disagreed. Ran three live tests against the hosted production instance
(synthetic rows, created + exercised + hard-deleted; scratchpad scripts
`car132-*.mjs`):

1. **The exact route.ts:227 claim shape** (`.update({status:'sending'})
   .eq(id).eq(status,'pending').select('id').single()`) on the exact table
   (`email_follow_up_messages`) **returns the updated row on success**. No trap.
2. The `.select()` (non-single) variant and even rule 17's original
   `.is(col, null)` lock shape also return the representation fine.
3. **Production has zero rows stranded in `'sending'`**, zero overdue pending
   messages (all 3 pending rows are future-dated with active parents). Premium
   auto-send is NOT broken; nothing needs recovery.

So: current hosted PostgREST does **not** re-apply request filters to the
mutation representation. Rule 17's documented mechanism doesn't reproduce today
(either Supabase upgraded PostgREST since 2026-07-09 or the original incident
was misdiagnosed). The audit verifier who rejected the premise was right.

**BUT the "verify while here" item found a genuinely live bug**: db.ts's
`cancelScheduledEmail` writes `status='cancelled_user'`, which the
`scheduled_emails` CHECK (pending/sent/cancelled — never widened by any
migration) rejects with 23514. Every MCP scheduled-email cancel has always
failed in production. Root cause: a stray `CancelledUser` entry in
`ScheduledEmailStatus` (email_follow_ups vocabulary leaked into the
scheduled_emails enum); db.ts used it while the UI route correctly writes
`'cancelled'`.

## What ships

1. **db.ts `cancelScheduledEmail`**: write `ScheduledEmailStatus.Cancelled`
   (the real fix) + count-based CAS.
2. **db.ts `cancelFollowUpSequence`**: count-based CAS (keeps `'cancelled_user'`,
   valid on email_follow_ups).
3. **route.ts claim**: switch to the count-based pattern anyway — consistency
   with the house convention (rule 17, CAR-108), immune to representation/RLS
   visibility semantics on any future PostgREST, and stops audits re-flagging it.
4. **constants.ts**: delete the dead, landmine `ScheduledEmailStatus.CancelledUser`.
5. **Tests**: count-based claim mock + the previously-zero-coverage premium
   send-success path + contested-claim path (`send-follow-ups-tier.test.ts`);
   new `mcp-cancel-cas.test.ts` covering both cancel helpers (status values,
   count semantics, child-cancel ordering).
6. **NO recovery migration** — nothing is stranded.
7. **CLAUDE.md learned rule** recording the empirical finding so rule 17's
   mechanism claim doesn't drive false "critical" diagnoses again.

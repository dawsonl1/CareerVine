# CAR-238 — MCP company notes should be ordinary pipeline notes

Adding a company note over MCP must produce the same note the UI's "Add note" produces, so
it appears in the normal Notes list and cannot silently vanish.

## The bug, confirmed live

Two write paths, two tables:

| Path | Writes |
|---|---|
| MCP `add_company_intel` | `target_company_notes` (per-target intel log) |
| UI "Add note" | `pipeline_notes` (per-cycle), via `save_pipeline_cycle` |

`careervine/src/components/companies/pipeline/researching-notes.tsx:147` renders MCP notes
only as a fallback:

```ts
const showIntel = intelNotes && intelNotes.length > 0 && notes.length === 0 && !isComposing;
```

So the first pipeline note hides every MCP note permanently, and the collapsed stage summary
never renders them either. Reproduced on Brevium (target 186): a 1,653-char intel note is
still in the database and invisible in the UI behind two notes reading "test" and "test2".

**Nothing was deleted.** This is a display bug that silently buries research, which is worse
than a visible failure because the user has no reason to go looking.

## The hazard that has to be fixed first

`save_pipeline_cycle` reconciles children by **delete-not-in**:

```sql
DELETE FROM pipeline_notes
WHERE cycle_id = v_cycle_id
  AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'notes','[]'::jsonb)) e);
```

A save deletes any row the saving client did not have in hand. Moving the MCP write onto
`pipeline_notes` without changing this converts today's display bug into real data loss: MCP
writes a note, the open tab autosaves 800 ms after the next keystroke, note gone. The same
hazard already exists between two browser tabs and is not hypothetical.

So the order is: make the reconcile non-destructive, THEN move the write.

## Plan

1. **Migration: non-destructive reconcile.** Replace delete-not-in with an explicit
   `deleted_ids` list in the payload, for every child collection in `save_pipeline_cycle`
   (notes, programs, applications, interview_rounds), not just notes. Rows the client never
   saw are left alone instead of destroyed. Absent `deleted_ids`, delete nothing.
   Keep the signature stable so no caller breaks.
2. **Client: send deletions explicitly.** `pipeline-state.ts` / `use-pipeline-autosave.ts`
   track ids removed in this session and pass them through `cyclePayloadFromForm`.
3. **MCP: write a real pipeline note.** `add_company_intel` resolves the company-wide target,
   its active cycle, and inserts a `pipeline_notes` row (creating the cycle if absent) instead
   of a `target_company_notes` row.
4. **Backfill existing intel notes** into `pipeline_notes` on the active cycle so nothing that
   was written before this change stays buried, then keep rendering any residual
   `target_company_notes` unconditionally rather than as a fallback (drop the
   `notes.length === 0` clause) so old rows can never hide again.
5. **Tests.** The reconcile is the risky part, so it gets integration coverage against the
   real migrated database: a save that omits a concurrently-added note must NOT delete it,
   and an explicit deleted id must. Plus a unit test that the MCP tool writes where the UI
   reads, and a regression test on the `showIntel` gate.

## Verification

`npm run test`, `check:conventions`, `test:integration` against a full `supabase db reset`,
and `build`. Migration validated per rule 32 by executing it against production inside
`BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;`, not by a dry run. Every new test falsified.

## Out of scope

Auto-advancing the company stage on reply is CAR-239.

# CAR-270 — MCP pipeline

Third of four MCP tickets (reads → writes → **pipeline** → output schemas).

## What is invisible

Five tables have no MCP surface at all: `pipeline_cycles`, `pipeline_applications`,
`pipeline_interview_rounds`, `pipeline_notes`, `pipeline_programs`. CAR-265 gave the
agent the ability to *set* a company's stage while leaving it unable to read what that
stage contains.

## The asymmetry, confirmed

`add_company_intel` writes `pipeline_notes`. `get_company` returns `target.notes` from
`target_company_notes`. **Different tables, no overlap** — `getCompanyDetail` never
touches `pipeline_notes`. So an agent writes intel, re-reads the company, sees nothing
it recorded, and writes it again.

Both tool descriptions say "recruiting-intel log", which is true of a table and not of
the same table, so they actively imply a round trip that does not exist. Fixed here by
making the pipeline read return the notes AND correcting both descriptions.

Note: a complete picture needs both tables. The CAR-238 backfill copied
`target_company_notes` into `pipeline_notes` but **deliberately left the source rows**,
and the UI still renders them in a read-only "From your target record" block.

## Two hazards this design is built around

**1. `pipeline-queries.ts` is outside the scoping gate.** Its import scan globs
`src/lib/data/*.ts` exactly, so `src/lib/pipeline-queries.ts` is one directory up and
matches nothing. Importing `loadPipeline` straight into a tool would compile, pass CI,
and be the only MCP data path in the codebase with zero mechanical enforcement.

So the reader is re-exported through `src/lib/data/pipeline.ts`, which pulls it into
`DATA_TABLES`, forces a classification entry, and makes the drive exercise its real
queries. Same precedent `setCompanyStage` set in CAR-265, for the same reason.

**2. `save_pipeline_cycle` performs no ownership check.** No `auth.uid()`, no `user_id`
predicate; it is `SECURITY INVOKER` and its migration says outright that RLS above it is
the enforcement. Verified against production: `service_role` **does** hold EXECUTE
(`has_function_privilege` returns true for both RPCs), and service-role bypasses RLS. So
the RPC will happily write into another tenant's pipeline given an arbitrary integer.
**Every MCP call asserts ownership of the target row in TypeScript first.**

## Tools

| Tool | Does |
| --- | --- |
| `get_company_pipeline` | The whole board for a company: every scope, every cycle, stage, programs, notes, applications, interview rounds |
| `log_application` | Append an application to a cycle (job title, location, date applied) |
| `log_interview_round` | Append an interview round (date, interviewer, notes) |

Appends read the current cycle, add one entry, and send the **full** collection back
through `savePipelineCycle`, exactly as the UI does. Sending only the new row would
renumber `position` from 0 and collide with existing entries, because the RPC assigns
`position = ord - 1` over whatever payload it is given.

Deletion stays out. CAR-238 made deletes explicit (`deleted.*`), and a payload without
that key deletes nothing, which is what makes concurrent MCP and UI writes survivable.
The server has no delete tools and this does not add the first one.

## Decisions worth stating

- **Attachment paths are not returned.** `resume_path` is `${userId}/${uuid}.pdf` in a
  private bucket; the value is useless without a signed URL and embeds the user's uuid.
  The tools return `name` and `size_bytes` so "which resume did I send to Adobe" is
  answerable, and nothing that looks fetchable but is not.
- **`declined_next_cycle` is described as a UI intent flag**, not an outcome. It means
  "declined to open cycle N+1", gates no logic, and an agent reading it as "rejected"
  would be wrong.
- **`interview_rounds.questions` is labelled "Interview notes" in the UI** and is
  free-form text, not a question list. The tool says so.
- **Empty-bodied notes never survive a read**: `normalizeCycleFormState` drops them.
- `active_cycle` is a per-scope UI cursor, not a status, and is clamped on read.

## Tests

- Classification entries + drives in `db-scoping.test.ts` for every new export, so the
  gate exercises the scoping rather than trusting it.
- Handler tests through the CAR-262 fake-server harness, including that an appended
  application does not disturb the existing ones and that the payload carries no
  `deleted` key.
- Falsify: strip the ownership assertion and confirm the gate fails.

## Verification

`npm run test`, `test:coverage` (the `src/mcp/**` ratchet), `check:conventions`,
`test:integration`, `lint`, `build`.

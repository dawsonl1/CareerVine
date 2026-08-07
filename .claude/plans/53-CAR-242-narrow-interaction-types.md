# CAR-242 — Narrow conversation/interaction types to five, unify both pickers, add free-text detail

## Problem

Three disjoint vocabularies describe the same concept, and none agree:

| Source | Values |
| --- | --- |
| `CONVERSATION_TYPE_OPTIONS` (`careervine/src/lib/constants.ts:310`) → `meetings.meeting_type` | coffee, phone, video, in-person, lunch, conference, networking, other |
| inline list (`contact-timeline-tab.tsx:298`) → `interactions.interaction_type` | email, phone, video, coffee, lunch, conference, social, other |
| MCP `log_interaction` (`upkeep.ts:31`) → `interactions.interaction_type` | call, coffee, event, email, meeting, other |

Only `coffee` and `other` are common to all three. `in-person`/`networking` exist only in the first, `social` only in the second, `call`/`event`/`meeting` only in the third. Neither column has a CHECK constraint, so all of it is writable and none of it is enforced.

## Production data (measured before scoping)

- `meetings.meeting_type`, 23 rows: `phone` 7, null 6, `coffee` 4, `video` 4, `networking` 1, `other` 1.
- `interactions.interaction_type`, 70 rows: **all** `email`, every one auto-created by the send path. The manual interaction picker has never produced a single row.

## Decision

One shared vocabulary of five, replacing all three:

| Value | Label |
| --- | --- |
| `career-fair` | Career Fair |
| `networking` | Networking Event |
| `coffee` | Coffee Chat |
| `text` | Text Message Chat |
| `other` | Other (opens a free-text field) |

**Coffee Chat encompasses phone and video calls.** It is the 1:1-conversation bucket regardless of medium. The picker carries a one-line hint saying so, because without it a user logging a phone call reaches for Other and defeats the whole consolidation.

`email` stays a valid `interaction_type` as a **system-only** value written by the send path. It is never user-selectable.

Free text lives in new nullable `*_type_detail` columns, so the type column stays a clean enum for filtering, grouping and search.

## Design notes

### Why the columns become `text`

Every CHECK-guarded column in this schema is `text`; `meeting_type` and `interaction_type` are `varchar`. That difference is load-bearing: for a `varchar` column Postgres renders the constraint as `((col)::text = ANY (...))`, and `check-constraints.itest.ts:97` matches on the literal `(col = ANY ` — so a CHECK on a varchar column would be **silently invisible to the conformance guard**, which is the exact class of gap that suite exists to close (CAR-132, CAR-178). Both columns are converted to `text` in the same migration.

### Detail column invariant

`CHECK (detail IS NULL OR (type = 'other' AND char_length(detail) BETWEEN 1 AND 80))`

The detail is meaningless unless the type is Other, so the constraint makes that real rather than trusting every write path to clear it. Both writers must null the detail whenever the type is not `other`; tests cover the switch-away-from-Other path.

### NULL handling

`meeting_type` is nullable (CAR-122 made bare calendar events untyped). The CHECK is written as a bare `IN (...)` with no `IS NULL OR` guard: a NULL operand yields NULL, and a CHECK only fails on FALSE, so NULLs pass. Writing it the "defensive" way would break the conformance parser (see above). This is commented in the migration.

## Slices

### 1. Migration (`supabase/migrations/`)

1. `ALTER COLUMN ... TYPE text` on both columns.
2. Backfill, before any constraint is added:
   - meetings: `phone`, `video`, `in-person`, `lunch` → `coffee`; `conference` → `networking`; `coffee`/`networking`/`other` unchanged; any other non-null value → `other` with the original preserved in `meeting_type_detail`.
   - interactions: `email` unchanged; `phone`, `video`, `in-person`, `lunch`, `call`, `meeting` → `coffee`; `conference`, `event` → `networking`; `coffee chat` (a malformed value that exists in a fixture) normalized → `coffee`; `social`/`other` → `other`; any other value → `other` with the original in `interaction_type_detail`.
3. Add `meeting_type_detail` / `interaction_type_detail` (`text`, nullable).
4. Add the four CHECK constraints.

Order matters: backfill must precede the constraints or the ALTER fails on existing `phone`/`video` rows.

### 2. Constants (`careervine/src/lib/constants.ts`)

- `ConversationType` const object + `CONVERSATION_TYPE_OPTIONS` (five entries, with `iconName`).
- `INTERACTION_TYPE_VALUES` = the five plus `email`, for the conformance guard.
- `CONVERSATION_TYPE_DETAIL_MAX_LENGTH = 80`, mirroring the CHECK.
- Delete the `MEETING_TYPE_OPTIONS` deprecated alias (zero importers).
- Icons: Career Fair `Briefcase`, Networking Event `Users`, Coffee Chat `Coffee`, Text Message Chat `MessageSquare`, Other `CircleEllipsis`.

### 3. Conversation modal (`components/conversation-modal/`)

- Chip row driven by the new list; `ICON_MAP` updated to the five icons.
- Hint line under the chips: Coffee Chat covers phone and video calls.
- Free-text input appears when `other` is selected; cleared when the user switches away.
- **Fix the `|| "coffee"` defaults at `index.tsx:141,158`**: editing a meeting with a null type currently fabricates `coffee`, so opening an MCP-created or bare calendar meeting and saving stamps a type the user never chose. Default to `""` instead.

### 4. Calendar page (`app/calendar/page.tsx`)

Select options from the shared list, plus the detail input and the same clear-on-switch rule. `linked.meeting_type || ""` prefill still works since every surviving value is in the list post-backfill.

### 5. Contact timeline (`components/contacts/contact-timeline-tab.tsx`)

Replace the inline eight-value list with the shared five. An interaction whose type is the system `email` value is not editable into a user type; the picker shows the five and the detail field.

### 6. MCP (`mcp/tools/upkeep.ts`, `mcp/lib/db.ts`)

- `z.enum` → the five values.
- New optional `detail` param, accepted only with `type: "other"`.
- Fix the tool description, which today enumerates five values while the enum accepts six.
- `logInteraction` takes and writes the detail.

### 7. Home page + transcribe script

- `app/page.tsx:959` Meet-link prefill `"video"` → `"coffee"` (Coffee Chat now covers video calls).
- `scripts/local-transcribe/ingest.ts:67` default `?? "video"` → `?? "coffee"`, validated against the list.

### 8. Tests

- `check-constraints.itest.ts`: two new `VocabSpec` entries with `requireCheck: true`.
- Update fixtures carrying dead values: `meetings-page.test.tsx:124,299`, `dossier.test.ts:79`, `db-scoping.test.ts:217`, `outreach-request-shape.test.ts:322`, `postgrest-ceiling.itest.ts:245`, `tenant-graph.ts:180`.
- New coverage: detail cleared on switch away from Other, detail rejected when type is not Other, MCP enum accepts exactly five, backfill mapping.

### 9. Docs and copy

- `README.md:43` says "Eight conversation types" — a hard count, now five.
- `supabase/database-reference/schema-notes.md:200,231` describe the old vocabularies.
- Regenerate `database.types.ts` (types-drift CI check) and refresh the schema reference dump.
- `careervine/public/docs/index.html` does not enumerate the values, so no change needed there. Landing, privacy and terms pages are clean. Verified, not assumed.

## Deploy order (rule 42)

The code reads and writes `*_type_detail`, which its own migration adds, and the CHECK constraints reject values the old code writes. So the migration is applied to production **before** the PR merges, validated first inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` per rule 32.

## Verification

`npm run test`, `npm run check:conventions`, `npm run test:integration`, `npm run build` from `careervine/`.

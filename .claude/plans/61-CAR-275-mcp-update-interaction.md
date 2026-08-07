# CAR-275 — MCP `update_interaction`

`log_interaction` is a one-way write. An agent that logs a touchpoint with the wrong type, the
wrong date, a thin summary, or against the wrong Jane cannot correct it over MCP, and the server
deliberately ships no delete tools, so the bad row is permanent until Dawson opens the app. The
web editor has done all of this since CAR-249 (`timeline-detail-modal.tsx`) plus the CAR-260
Remove/Restore strike; MCP has none of it.

Two scope calls Dawson made up front: reassignment to a different contact is **in**, and
Remove/Restore is **in** (it is the no-delete-consistent retraction).

---

## 1. `update_interaction` tool — `careervine/src/mcp/tools/upkeep.ts`

Patch semantics: every field optional, absent means unchanged. An empty patch is an error
("nothing to update") rather than a silent no-op, so a malformed call is visible.

`updateInteractionSchema` is exported for the schema test, matching `contacts.ts` / `email.ts`:

| field | shape | note |
| --- | --- | --- |
| `interaction_id` | `z.number().int()` | required |
| `move_to_contact_id` / `move_to_contact_name` | optional | **deliberately not** `contact_id` / `name`. Everywhere else on this server those two identify the *subject*; here the subject is `interaction_id` and the contact is a *destination*. Reusing the names for an inverted meaning is exactly the footgun an LLM falls into. |
| `type` | `z.enum(CONVERSATION_TYPE_VALUES)` | the same five as `log_interaction`, derived from the shared vocabulary rather than hand-listed (CAR-242). `email` stays out: the send path writes it, callers do not. |
| `detail` | `z.string().max(CONVERSATION_TYPE_DETAIL_MAX_LENGTH).nullable()` | only meaningful with `type: other` |
| `date` | `z.string()` | ISO; `NaN` check throws, as in `log_interaction` |
| `summary` | `z.string().nullable()` | nullable so an agent can clear one |
| `excluded` | `z.boolean()` | the CAR-260 strike |

### The detail/type CHECK

`interactions_interaction_type_detail_check` rejects a detail carried over from a type the caller
switched away from, so the patch recomputes it through `normalizeConversationTypeDetail` against
the **effective** type whenever either field is touched:

```
nextType   = type   ?? current.interaction_type
nextDetail = detail !== undefined ? detail : current.interaction_type_detail
patch.interaction_type_detail = normalizeConversationTypeDetail(nextType, nextDetail)
```

Switching `other` → `coffee` without mentioning `detail` therefore clears the stale detail
instead of 23514-ing. This is the same normalize call the web editor makes at its own save site.

### System-written email rows are guarded

Every interaction the send path writes carries `interaction_type = 'email'` and an
`email_message_id`, and at CAR-242 that was **all 70 production rows** — so this is the row an
agent is most likely to encounter, not an edge case. Its type, date and contact mirror a real
sent email, and rewriting any of them would make the record lie.

`type`, `detail`, `date` and reassignment are refused on such a row, with an error that says
which fields *are* editable. `summary` and `excluded` stay allowed: annotating what a sent email
accomplished is legitimate, and striking one is the existing CAR-260 affordance.

### Reassignment

Resolve the destination through `resolveContact` (which is already `uid()`-scoped and returns
candidates on ambiguity), then write `contact_id` and graduate the destination through
`activateContactIfDormant`, exactly as `log_interaction` does — moving a real touch onto a
prospect is a relationship-forming write. A move to the contact the row already sits on is a
no-op on that field rather than an error.

The response names what changed, so an agent reading `content[0].text` can confirm the move
landed: `Moved to Jane Ruiz. Graduated into the active network`.

---

## 2. Ownership — `careervine/src/mcp/lib/db.ts`

`interactions` has **no `user_id` column**; every consumer scopes through `contacts!inner(user_id)`
(the `/api/timeline/exclude` header says the same thing, which is why that route rides RLS instead
of a service client). Under MCP the service role bypasses RLS, so scoping is this code's job.

Two additions:

- `assertInteractionOwned(interactionId)` — the scoped read, `contacts!inner(user_id)` +
  `.eq("contacts.user_id", uid())`, returning the current row. A foreign id misses and throws
  rather than silently succeeding.
- `editInteraction(interactionId, patch)` — asserts, applies the email-row guard, writes, and
  activates the destination on a move. **One exported function** so the ownership read and the
  write it authorizes sit inside a single invocation, which is the shape `db-scoping.test.ts`
  can actually prove ("keys exclusively on ids the same invocation PROVED it owns").

The write itself reuses the shared `updateInteraction` from `@/lib/data/interactions` rather than
hand-rolling a near-duplicate query in `db.ts` — that is CAR-151's whole point, that this file is
a thin layer and not a fork.

---

## 3. `get_contact_dossier` gains `include_removed`

`getDossierBundle` filters `is_excluded` on both interaction legs today, so a removed interaction
is invisible over MCP and **restore would be unreachable** — the agent could strike a row and
never find it again. The flag defaults false, so the grounding payload is byte-identical unless
asked for.

Three things this must get right:

1. **`lastTouch` must ignore removed rows even when they are included.** `buildDossier` derives
   `last_touch` / `last_touch_days_ago` from `bundle.interactions`, and CAR-260's contract is that
   a struck row stops feeding last-touch. Passing removed rows in without filtering the touch
   computation would quietly reintroduce the exact bug that ticket fixed. Guarded by a test.
2. **Removed rows are marked.** Each shown interaction carries `removed: true` only when the flag
   is on; with the flag off the field is absent entirely, so the default shape does not move.
3. **`total` respects the flag**, and the tool description says the flag is for auditing and
   restoring, not for grounding an email — this payload is what the model quotes from.

---

## 4. Tests

- `careervine/src/mcp/__tests__/tool-schemas.test.ts` — `updateInteractionSchema`: rejects an
  `email` type, rejects an over-length detail, accepts a nullable `summary`, requires
  `interaction_id`.
- `careervine/src/mcp/__tests__/update-interaction.test.ts` — the handler driven through the
  recording client, `write-tools.test.ts` style (which rows get written, in what order, what is
  refused): patches only the fields given; clears a stale detail on switch-away; refuses
  type/date/move on a system email row while allowing summary and excluded; reassignment asserts
  the destination and graduates a dormant one; empty patch, bad date, and a foreign
  `interaction_id` all throw.
- `careervine/src/mcp/__tests__/db-scoping.test.ts` — `@/lib/data/interactions.updateInteraction`
  moves from `web-only` to `mcp-covered` (`coveredBy: "editInteraction"`, `touches: "interactions"`),
  and the two new `db.ts` exports get entries. A missing entry fails the export enumeration, so
  this is not optional.
- `careervine/src/mcp/__tests__/dossier.test.ts` — `include_removed` on and off, plus the
  last-touch guard above.

Local gate before pushing: `npm run test`, `npm run check:conventions`, `npm run test:integration`
(the last two are not in CLAUDE.md's verify list but are required here).

---

## 5. Copy that has to move in the same branch

- `careervine-mcp/README.md` — the Relationship-upkeep row in the tool table, and the "no delete
  tools" note, which should now say the strike is the retraction path.
- `careervine/public/docs/index.html` — a tool card beside `log_interaction`. No em dashes
  (rule 35).
- `careervine/README.md` — product-perspective line if it inventories MCP tools (rule 7).

No migration and no schema change: every column this writes already exists.

# Plan 26 — CareerVine MCP Server for Claude Code (full build)

## Goal

A local MCP server that turns Claude Code into a full command-line operator
for CareerVine: research anyone in the network, write and send grounded
emails, run the outreach queue, log interactions, manage action items and
follow-ups, pull company intel, and work the calendar — the entire
relationship workflow without opening the app.

Built in one pass — this is the complete spec, not an MVP with phases.

## Architecture

```
careervine-mcp/                  (new top-level package in the repo)
  server.ts                      MCP entrypoint (stdio), registers all tools
  lib/
    env.ts                       loads careervine/.env.local + CAREERVINE_USER_ID
    db.ts                        service-role Supabase query layer (see below)
    dossier.ts                   assembles + formats the contact dossier
    email-policy.ts              shared send/draft guards (cap, bounce, guessed)
    markdown.ts                  markdown → email-safe HTML for body inputs
  tools/
    contacts.ts                  search, dossier, add, note, tag, tier
    email.ts                     draft, send, schedule, sequences, history
    outreach.ts                  queue, companies, intel, stage override
    upkeep.ts                    interactions, action items, due list, health
    calendar.ts                  meetings list/create
  tsconfig.json                  maps "@/*" → ../careervine/src/* for lib reuse
  package.json                   @modelcontextprotocol/sdk, tsx, googleapis,
                                 @supabase/supabase-js, zod
.mcp.json                        (repo root) registers the server for Claude Code
```

- **Runtime**: `npx tsx careervine-mcp/server.ts` — no build step; tsx resolves
  the `@/*` alias into the Next.js source tree.
- **Registration** (`.mcp.json`, no secrets in it):

  ```json
  {
    "mcpServers": {
      "careervine": {
        "command": "npx",
        "args": ["tsx", "careervine-mcp/server.ts"],
        "env": { "CAREERVINE_USER_ID": "<dawson's auth.users id>" }
      }
    }
  }
  ```

- **Credentials**: read at startup from `careervine/.env.local`
  (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `GOOGLE_CLIENT_ID/SECRET`). Refuse to start if missing; never log values.
- **Gmail/Calendar auth**: reuse `gmail_connections` tokens via
  `getGmailClient(userId)` from `careervine/src/lib/gmail.ts`. The granted
  `gmail.modify` scope already covers `users.drafts.create` — **no re-consent
  needed**. Calendar scopes are granted too.

### The data-layer decision (important)

`careervine/src/lib/queries.ts` is built on the **browser** Supabase client
(anon key + user session + RLS). That client cannot run in a Node MCP
process — no session means RLS returns nothing. Therefore:

- **Reused directly from the app** (already service-client based or pure):
  `lib/gmail.ts` (send, drafts, sync, clients), `lib/stage-derivation.ts`,
  `lib/outreach-queue.ts` (pure `buildOutreachQueue`), `lib/gmail-helpers.ts`,
  constants and types (`database.types.ts`).
- **Reimplemented in `careervine-mcp/lib/db.ts`**: the read/write queries the
  tools need, using `createSupabaseServiceClient()` with every query scoped to
  `CAREERVINE_USER_ID`. These mirror the app's select shapes (same relation
  embeds as `getContacts`/`getContactById`) but stay compact. This is a
  deliberate, contained duplication (~200 lines) — cleaner than refactoring
  the app's whole query layer for client injection.
- **Extracted to shared code** (app + MCP both call it, policies can't drift):
  `sendTrackedEmail()` — pulled out of `/api/gmail/send/route.ts` into
  `careervine/src/lib/email-send.ts`: daily-cap check, bounced-address
  refusal, send, `email_messages` caching, interaction logging, **no tier
  auto-graduation** (reply-based policy holds). The route becomes a thin
  wrapper; existing route tests stay green and new tests cover the lib.

### New app-side lib additions

1. `createDraft(userId, {to, cc, bcc, subject, bodyHtml, threadId?})` in
   `lib/gmail.ts` — `users.drafts.create` with the same MIME composer
   `sendEmail` uses (factor the MIME builder out so both share it). Returns
   draft id + Gmail deep link.
2. `lib/email-send.ts` — `sendTrackedEmail()` as above.

## Tool catalog (complete)

Conventions: every tool validates input with zod; contact-referencing tools
accept `contact_id` or exact `name` (ambiguity → error listing candidates
with ids); write tools carry MCP annotations (`readOnlyHint: false`,
`destructiveHint` where apt) so Claude Code's permission prompts land; all
outputs are structured JSON with a short human-readable `summary` field.

### Contacts & research

1. **`search_contacts`** — `query`, optional `tiers[]`, `limit` (default 10).
   Matches name / email / company / title / school / industry / tags (same
   semantics as the contacts page). Returns compact rows: id, name, headline,
   current company+title, tier, derived outreach stage, last-touch days,
   primary email + its source flag.

2. **`get_contact_dossier`** — `contact_id | name`, optional `depth`
   (`recent` default = last 10 interactions/emails/meetings; `full` = all).
   One structured document: identity (name, headline, persona, location,
   LinkedIn), tier + derived stage (+ override), cadence + last touch, work
   history, education (+ alum flag), emails with source flags
   (verified/pattern-guessed/bounced), phones, notes, met_through, tags,
   pipeline `review_note`, open + waiting-on action items, recent completed
   ones, interactions, meetings, and cached email thread history (direction,
   subject, snippet, date). This is the grounding payload for writing an
   informed email.

3. **`add_contact`** — name + optional industry, LinkedIn URL, emails[],
   phones[], company `{name, title, is_current}`, school `{name, degree,
   field}`, location, notes, cadence, tier (default `active`). Reuses the
   find-or-create company/school/location patterns so no duplicate entities.

4. **`add_contact_note`** — `contact_id`, `note`. Appends timestamped note
   (same behavior as the app's `appendContactNote`).

5. **`tag_contact`** — `contact_id`, `tags[]` (find-or-create tags, link).

6. **`set_network_status`** — `contact_id`, `status: active|prospect|bench`.
   Mirrors the app's promote/demote/activate mutations. Description notes
   that replies/interactions/meetings graduate automatically.

### Email

7. **`create_email_draft`** — `contact_id`, `subject`, `body` (markdown or
   HTML; markdown is converted), optional `thread_id` (reply), optional
   `to_email` override (defaults to primary; **refuses bounced**, warns on
   pattern-guessed). Creates a real Gmail draft; returns draft id + deep
   link. Tool description: *default path — prefer this unless the user
   explicitly says to send.*

8. **`send_email`** — same inputs plus required `confirm: true`. Runs
   `sendTrackedEmail()`: daily cap (100/day), bounce refusal,
   pattern-guessed warning, cache + interaction log. Returns message/thread
   ids and how much of today's cap remains.

9. **`schedule_email`** — same inputs plus `send_at` (ISO). Inserts into the
   scheduled-emails table the app's QStash cron already processes; returns
   scheduled id + local-time confirmation.

10. **`create_follow_up_sequence`** — `contact_id`, `thread_id` (or the
    original message id), `messages[] {subject, body, send_after_days}`.
    Writes `email_follow_ups` + `email_follow_up_messages`; the existing
    cron sends them and **auto-cancels on reply** (which also graduates the
    contact, per policy).

11. **`list_scheduled`** — pending scheduled emails + active follow-up
    sequences (with next send times).

12. **`cancel_scheduled`** — `scheduled_email_id | follow_up_id`. Cancels a
    pending send or a whole sequence.

13. **`search_email_history`** — `query`, optional `contact_id`, `limit`.
    Full-text-ish search over cached `email_messages` (subject + snippet
    ilike), newest first: "what did Tim say about referrals?"

14. **`get_email_thread`** — `thread_id`. Full messages via
    `getFullMessage()` for the thread (live Gmail fetch, HTML→text).

### Outreach engine

15. **`list_outreach_queue`** — the plan-25 queue via `getContactStages` +
    `buildOutreachQueue`: companies with people ready for first touch /
    follow-up, stages, and why. Lets Claude run a whole session: "who's
    next? pull their dossier. draft them."

16. **`list_companies`** — target companies with priority, stage rollups,
    people counts (via `getCompanies`); optional `targets_only`.

17. **`get_company`** — `company_id | name`. `getCompanyDetail`: who works
    there now/past by office, alum matches, target status + priority,
    program/application dates, recruiting-intel log.

18. **`add_company_intel`** — `company_id`, `note`, optional office. Appends
    to the target-company intel log (`addTargetCompanyNote`; auto-creates
    the target-company row if absent via `addTargetCompany`).

19. **`set_stage_override`** — `contact_id`, `stage | null`. For outreach
    that happened off-platform (LinkedIn DMs), mirroring `setStageOverride`.

### Relationship upkeep

20. **`log_interaction`** — `contact_id`, `type` (call/coffee/event/email/
    other), `date` (default now), `summary`. Inserts the interaction —
    which activates prospects/bench, per policy (tool description says so).

21. **`create_action_item`** — `title`, `contact_ids[]`, optional
    description, `due_at`, `direction` (`todo` | `waiting_on`).

22. **`list_action_items`** — filters: `due` (overdue/today/week/all),
    `direction`, `contact_id`. Includes waiting-on items with age.

23. **`update_action_item`** — `action_item_id`, one of: `complete`,
    `snooze_until`, `due_at`, `title/description` edits.

24. **`list_due_followups`** — contacts past cadence (the home-page
    reach-out list): name, days overdue, never-contacted flag, has-email.

25. **`get_network_health`** — streak, on-track ratio, neglected contacts,
    activity heatmap totals, per-tier counts — "how am I doing?"

### Calendar

26. **`list_meetings`** — `range` (today/week/custom). Cached calendar
    events with attendee→contact matching (same logic as the home page).

27. **`create_meeting`** — `contact_id`, `title`, `start/end`, optional
    description/Meet link flag. Uses the existing calendar create-event
    path (Calendar event + invite), links the contact (activates tier, per
    policy).

**Deliberately excluded**: AI generation tools (the app's suggestion/writer
engines). Claude is the generator; the server exposes data and actions only.

## Safety & guardrails

- Single-user by construction: every query scoped to `CAREERVINE_USER_ID`;
  server refuses to start without it. Service-role key never leaves the
  local process; `.mcp.json` holds no secrets.
- `send_email` requires `confirm: true`; the daily cap is re-checked
  server-side inside `sendTrackedEmail()` — a runaway loop can't torch
  deliverability. Bounced addresses are refused everywhere (draft, send,
  schedule, sequence).
- Destructive-ish writes (cancel, complete, tier moves) are annotated so
  Claude Code's permission system prompts appropriately. No delete tools in
  v1 (no `delete_contact`/`delete_meeting`) — lowest-regret omission.
- All email paths flow through the shared lib, so app and MCP can never
  disagree on policy (caps, bounce handling, reply-based graduation).

## Testing

- Vitest (existing suite conventions, tests live in `careervine/src/__tests__/`
  for shared lib code, `careervine-mcp/__tests__/` for MCP-only code):
  - `email-send.test.ts` — extracted `sendTrackedEmail`: cap enforcement,
    bounce refusal, interaction logging, no-graduation (mocked service client
    + gmail).
  - `gmail drafts` — `createDraft` MIME + API call (mocked gmail client).
  - `dossier.test.ts` — dossier assembly/formatting from fixture rows;
    depth capping.
  - `markdown.test.ts` — markdown→HTML conversion edge cases.
  - Tool input validation — zod schemas reject/accept representative inputs.
- Manual end-to-end script (documented in README): `claude mcp list` →
  search → dossier → draft (verify in Gmail) → send-to-self → schedule +
  cancel → log interaction → queue + company intel → create meeting.

## Implementation order (single build, ~sequential)

1. Scaffold package + env loading + service-client `db.ts` skeleton.
2. App-side lib work first (it's the riskiest): extract `sendTrackedEmail`,
   add `createDraft` + shared MIME builder, keep route tests green, add new
   lib tests.
3. Contacts tools (1–6) + dossier module and tests.
4. Email tools (7–14).
5. Outreach tools (15–19) — mostly wiring existing company-queries logic
   into service-client equivalents.
6. Upkeep tools (20–25).
7. Calendar tools (26–27).
8. `.mcp.json`, README section (setup, env, example prompts, tool table).
9. Full manual E2E pass; fix; final commit.

## Decisions taken (previously open questions)

- `send_email` ships in v1, confirm-gated — building it all at once was the
  directive, and the cap + confirm + permission-prompt stack is enough.
- Dossier defaults to recent-N with counts and offers `depth: "full"`.
- Naming/config stays Claude Code-first; Claude Desktop can reuse the same
  stdio entry later without changes.

# CareerVine MCP Server

A local [MCP](https://modelcontextprotocol.io) server that turns Claude Code into a command-line operator for CareerVine: research anyone in the network, write and send grounded emails, run the outreach queue, log interactions, manage action items, pull company intel, and work the calendar — the entire relationship workflow without opening the app.

## Setup

```sh
# one-time: install this package's dependencies
npm install --prefix careervine-mcp
```

That's it. The server is registered in the repo-root `.mcp.json`, so any Claude Code session opened at the repo root picks it up automatically (`claude mcp list` should show `careervine`).

### Credentials & configuration

- **Secrets & config** come from `careervine/.env.local` (Supabase URL/keys, Google OAuth client). Nothing personal lives in the committed `.mcp.json` (its `env` is empty).
- **Operating user**: set `CAREERVINE_USER_ID` (your `auth.users` id) in `careervine/.env.local`. `CAREERVINE_USER_EMAIL` works as an alternative — it's resolved against `auth.users` at startup. The server refuses to start if neither is set.
- **Database target**: production by default. Set `NODE_ENV=development` in the server env to use the local Supabase stack instead (follows the app's `getSupabaseEnv()` logic, including `NEXT_PUBLIC_SUPABASE_USE_PROD`).
- **Gmail/Calendar**: reuses the app's stored OAuth tokens (`gmail_connections`). The already-granted `gmail.modify` scope covers draft creation — no re-consent needed.

## Safety model

- **Single-user by construction** — every query is scoped to the configured user; the server refuses to start without one.
- **Drafting is the default path** — `send_email` requires `confirm: true` and re-checks the daily send cap (100/day) server-side via the app's shared `sendTrackedEmail()`, so app and MCP can never disagree on send policy.
- **Bounced addresses are refused everywhere** (draft, send, schedule, sequence); pattern-guessed addresses warn.
- **Guessed addresses are refused, not warned about** (CAR-217). A `to_email` that is not one of the contact's saved addresses throws, and only goes through if the caller passes `allow_unverified_address: true`. This replaced a warning, because a warning does not work on this surface: an agent guessed three `first.last@company.com` addresses, received the warning on each, sent anyway, and reported all three as delivered. Two had bounced. A model can ignore advisory text in a success payload; it cannot ignore a thrown error or forget a parameter the schema requires.
- **`send_email` never claims delivery.** It reports that Gmail ACCEPTED the message. A rejection arrives minutes later as its own notice in a separate thread, so it is invisible both in the sent folder and in the send result. `check_delivery` is the tool that answers "did it land", and the tool descriptions say so, because a tool description is documentation the model actually reads, unlike a prompt or skill file that can silently drift out of agreement with the code.
- **Follow-ups can be queued with the opening email.** `schedule_email` takes an optional `follow_ups` array, so one call queues the intro and its sequence. The steps stay dormant until the intro sends, then reply on its thread and cancel themselves the moment the contact writes back. `create_follow_up_sequence` accepts the same anchor via `scheduled_email_id` when the sequence is added separately. Steps inherit the opening email's time of day rather than a fixed UTC hour.
- **No tier auto-graduation on outbound email** — prospects graduate on a reply, a logged interaction, or a meeting, same as the app.
- **No delete tools** — the lowest-regret omission.

## Tools (39)

| Area | Tools |
| --- | --- |
| Contacts & research | `search_contacts`, `get_contact_dossier`, `add_contact`, `update_contact`, `add_contact_note`, `add_contact_email`, `add_contact_phone`, `tag_contact`, `untag_contact`, `set_network_status`, `defer_follow_up` |
| Email | `create_email_draft`, `send_email`, `check_delivery`, `schedule_email`, `create_follow_up_sequence`, `list_scheduled`, `cancel_scheduled`, `reschedule_follow_up`, `search_email_history`, `get_email_thread` |
| Outreach engine | `list_outreach_queue`, `list_companies`, `get_company`, `get_company_pipeline`, `add_company_intel`, `set_company_stage`, `update_company_target`, `log_application`, `log_interview_round`, `set_stage_override` |
| Relationship upkeep | `log_interaction`, `create_action_item`, `list_action_items`, `update_action_item`, `list_due_followups`, `get_network_health` |
| Calendar | `list_meetings`, `create_meeting` |

Deliberately excluded: AI generation tools — Claude is the generator; the server exposes data and actions only. Still no delete tools: `untag_contact` removes a tag's LINK to one contact, never the tag itself.

### Steering your own queue

`list_outreach_queue` orders by application deadline (inside the boost window) then priority, and `update_company_target` is what writes both. Recording a deadline you found on a careers page is how a company moves to the front of the queue you are about to work.

`set_company_stage` moves a company through researching → outreach_active → applied → interviewing → closed, and can move it BACKWARDS to correct a mistake. It writes the target row and the active pipeline cycle together, so the companies list and the company page never disagree. It is separate from the automatic advance that fires when someone who currently works there replies.

A stage or field set through MCP reaches an already-loaded companies list on its next fetch, or after that list's 5-minute cache window.

### Writing back

The server is no longer read-mostly. An agent that finds something can record it:

- `update_contact` edits a contact's own fields; `add_contact_email` / `add_contact_phone` attach details to someone already in the network, keeping exactly one primary.
- `update_company_target` sets `next_app_date`, the field the outreach queue's boost window orders by, so an application deadline read off a careers page is one the queue can then act on.
- `set_company_stage` moves a company through the pipeline. It writes both the target row and the active cycle, because the companies list reads one and the company page reads the other. It can move a company backwards, which the automatic reply-driven advance deliberately cannot.
- `defer_follow_up` snoozes an overdue contact or stops suggesting a first outreach, so "email now" is not the only answer to a due follow-up.

Still no delete tools, and nothing generates content: the model is the writer.

### The recruiting pipeline

`get_company_pipeline` returns the board behind a company's stage: every scope (company-wide and per-office), every application cycle, the researching programs, the intel notes, the applications you submitted and the interview rounds you sat.

**This is where `add_company_intel`'s notes are readable.** They live in `pipeline_notes`; `get_company`'s `target.notes` are a different, legacy table, so a note written by an agent was previously invisible to it on read-back.

`log_application` and `log_interview_round` append to a cycle. They round-trip the entries already there rather than sending only the new row, and never send a deletion, so an agent writing alongside the app cannot remove rows it never saw. Resume and cover-letter PDFs stay browser-uploads: the tools report a file's name and size, never its storage path, which is unusable without a signed URL and embeds the user's id.

`declined_next_cycle` is a UI intent flag meaning "declined to open the next cycle". It is not an outcome and does not mean rejected.

### Reading past the first page

Every list that can outgrow one response reports its window and how to move it, rather than truncating quietly:

- `list_companies`, `list_outreach_queue` — `limit` + `offset`.
- `get_company` — `limit` + `offset`, plus `group` to narrow to one of current/former/archived before paging a large roster.
- `get_email_thread` — `limit` + `before_index`, walking backwards through a long thread; the response carries `window_start` to pass back.
- `get_network_health` — `neglected_limit`, with `neglectedTotal` always reporting the real count.

`list_companies(targets_only: false)` omits `traction` and the alumni counts entirely and sets `traction_included: false`. That scope is too large to compute them over, and sending them as `0`/`null` made "not measured" indistinguishable from "measured, and it is nothing". Use `get_company` for real traction on one company.

## Example prompts

- *"Who do I know at Samsara? Pull the dossier on the recruiter and draft her a short intro email mentioning our shared school."*
- *"What's next in my outreach queue? Work the top company: dossiers for the two best people, drafts for both."*
- *"Did anyone reply this week? Search my email history with Capital One folks."*
- *"Log a coffee chat with Tim yesterday — we talked about APM referrals. Create a waiting-on item: he's intro'ing me to his PM."*
- *"How's my network health? Who am I neglecting?"*
- *"Set up a 30-minute Meet with Jane Doe next Tuesday at 2pm."*

## Development

Tool implementations live in `careervine/src/mcp/` (shared with the remote HTTP server, CAR-13). This package is the stdio entrypoint only.

```sh
npm run typecheck --prefix careervine-mcp     # type-check the server
npm run test --prefix careervine              # runs app + MCP test suites

# End-to-end smoke test (boots the real server over stdio, read-only calls)
cd careervine-mcp
NODE_ENV=development npx tsx scripts/e2e.ts "google"   # local stack
npx tsx scripts/e2e.ts "google"                        # production
```

### Architecture notes

- Runs via `tsx` with a `paths` alias mapping `@/*` → `../careervine/src/*`, so it reuses the app's source directly: `gmail.ts` (send/drafts/sync), `calendar.ts`, `email-send.ts` (shared send policy), `company-queries.ts` (service client injected via `setCompanyQueriesClient`), `stage-derivation.ts`, `outreach-queue.ts`, `follow-up-helpers.ts`.
- The app's data layer (`src/lib/data/*` behind the `queries.ts` barrel) relies on RLS for tenant isolation, so it can't run on the service-role client as-is (its `setDataClient()` seam plus explicit scoping is CAR-151's collapse path); the compact service-role equivalents the tools need live in `lib/db.ts`, every query explicitly user-scoped (the service role bypasses RLS, so scoping is the code's job).
- stdout is the MCP protocol channel — diagnostics go to stderr only.

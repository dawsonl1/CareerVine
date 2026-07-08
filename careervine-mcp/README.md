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
- **No tier auto-graduation on outbound email** — prospects graduate on a reply, a logged interaction, or a meeting, same as the app.
- **No delete tools** — the lowest-regret omission.

## Tools (27)

| Area | Tools |
| --- | --- |
| Contacts & research | `search_contacts`, `get_contact_dossier`, `add_contact`, `add_contact_note`, `tag_contact`, `set_network_status` |
| Email | `create_email_draft`, `send_email`, `schedule_email`, `create_follow_up_sequence`, `list_scheduled`, `cancel_scheduled`, `search_email_history`, `get_email_thread` |
| Outreach engine | `list_outreach_queue`, `list_companies`, `get_company`, `add_company_intel`, `set_stage_override` |
| Relationship upkeep | `log_interaction`, `create_action_item`, `list_action_items`, `update_action_item`, `list_due_followups`, `get_network_health` |
| Calendar | `list_meetings`, `create_meeting` |

Deliberately excluded: AI generation tools — Claude is the generator; the server exposes data and actions only.

## Example prompts

- *"Who do I know at Samsara? Pull the dossier on the recruiter and draft her a short intro email mentioning my BYU background."*
- *"What's next in my outreach queue? Work the top company: dossiers for the two best people, drafts for both."*
- *"Did anyone reply this week? Search my email history with Capital One folks."*
- *"Log a coffee chat with Tim yesterday — we talked about APM referrals. Create a waiting-on item: he's intro'ing me to his PM."*
- *"How's my network health? Who am I neglecting?"*
- *"Set up a 30-minute Meet with Jane Doe next Tuesday at 2pm."*

## Development

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
- The app's `queries.ts` is browser-client based and can't run in Node; the compact service-role equivalents the tools need live in `lib/db.ts`, every query explicitly user-scoped (the service role bypasses RLS, so scoping is the code's job).
- stdout is the MCP protocol channel — diagnostics go to stderr only.

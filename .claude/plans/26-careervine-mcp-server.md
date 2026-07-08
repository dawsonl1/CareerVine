# Plan 26 — CareerVine MCP Server for Claude Code

## Goal

A local MCP server that gives Claude Code direct, tool-based access to
CareerVine's data and actions, so Dawson can work his network from the
terminal/chat: *"pull everything we know about Sarah Chen and draft her a
follow-up about the PM role"* becomes one conversation instead of five app
screens.

MVP capability: **contact dossier → drafted (or sent) email**, grounded in
everything the app knows about the person.

## Why MCP (and why local)

- Claude Code natively speaks MCP; a stdio server registered in `.mcp.json`
  needs zero hosting, zero new auth surface, and runs only on Dawson's
  machines.
- The app's server-side libraries (`careervine/src/lib/*`) already contain
  every capability we need — Supabase service client, Gmail OAuth client with
  token refresh, send guards, stage derivation. The MCP server is a thin tool
  layer over existing code, not a new backend.
- Local + service-role key means no multi-user auth problem: the server is
  scoped to one user id (Dawson's), passed via env.

## Architecture

```
careervine-mcp/            (new top-level package in the repo)
  server.ts                MCP entrypoint (stdio transport)
  tools/
    contacts.ts            search, dossier
    email.ts               draft, send, history
    actions.ts             interactions, action items (phase 2)
    companies.ts           company intel (phase 2)
  lib/env.ts               loads careervine/.env.local + CAREERVINE_USER_ID
  tsconfig.json            maps "@/*" → ../careervine/src/* so app libs import cleanly
  package.json             deps: @modelcontextprotocol/sdk, tsx, googleapis, @supabase/supabase-js
```

- **Runtime**: `npx tsx careervine-mcp/server.ts` — no build step, tsx resolves
  the `@/*` path alias into the Next.js source tree. The imported libs
  (`lib/gmail.ts`, `lib/supabase/service-client.ts`, `lib/stage-derivation.ts`)
  are framework-free already; anything that pulls in Next-only modules gets a
  small standalone equivalent inside `careervine-mcp/lib/` instead.
- **Registration**: project-level `.mcp.json` so any Claude Code session in
  this repo gets the tools:

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

- **Credentials**: read from `careervine/.env.local` (already holds
  `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`). The server refuses to start without them and never
  logs values. Works on any machine that has the app checked out with its
  env file — same constraint the Supabase CLI already imposes.
- **Gmail auth**: reuses the `gmail_connections` row + `getGmailClient(userId)`
  refresh flow. The already-granted `gmail.modify` scope covers
  `users.drafts.create`, so **no OAuth re-consent is needed** for drafts.

## MVP tools

### 1. `search_contacts`
Input: `query` (name / company / school / title / email fragment), optional
`tiers` filter (`active` | `prospect` | `bench`), optional `limit`.
Output: compact rows — id, name, headline/title, current company, tier,
outreach stage, last-touch days. Mirrors the app's search semantics
(contacts page matching + `stage-derivation`).

### 2. `get_contact_dossier`
Input: `contact_id` (or exact name — resolve via search, error listing
candidates when ambiguous).
Output: one structured document, everything the app knows:
- Identity: name, headline, persona, location, LinkedIn, photo URL
- Tier + derived outreach stage (+ `stage_override`), last-touch, cadence
- Work history (companies, titles, dates, current flag) and education
  (schools, degrees, alum-match flag)
- Emails (with verified / pattern-guessed / bounced source flags) and phones
- Notes, `met_through`, tags, `review_note` from the scrape pipeline
- Open + waiting-on action items; recent completed ones
- Recent interactions and meetings (dates, types, summaries)
- Recent email history: threads, direction, subjects, snippets, dates
  (from cached `email_messages`; no live Gmail call needed)

This is the grounding payload for Claude to write a genuinely informed email.

### 3. `create_email_draft`
Input: `contact_id`, `subject`, `body_html` (or markdown → wrapped),
optional `thread_id` for replies, optional `to_email` override (defaults to
primary email; refuses bounced addresses; warns on pattern-guessed ones —
same policy as the compose UI).
Behavior: creates a **Gmail draft** via `users.drafts.create` (new
`createDraft()` helper in `lib/gmail.ts`, ~20 lines beside `sendEmail`).
Output: draft id + deep link (`https://mail.google.com/mail/#drafts?...`)
so Dawson can review and hit send from Gmail.
**This is the default path — safe, human-reviewed.**

### 4. `send_email`
Input: same as draft, plus required `confirm: true`.
Behavior: replicates the `/api/gmail/send` route's full policy, extracted
into a shared `sendTrackedEmail()` helper both the route and the MCP tool
call, so the two paths can't drift:
- daily send-cap check (100/day)
- bounced-address refusal, pattern-guessed warning
- send via `sendEmail()`, cache to `email_messages`, log the interaction
- **no tier auto-graduation** (reply-based policy from this session holds)
Output: message id + thread id.
Tool description explicitly tells Claude to prefer drafts unless the user
says "send it".

## Phase 2 tool ideas (roughly priority-ordered)

**Outreach workflow**
- `list_outreach_queue` — plan-25 company-by-company triage queue, so Claude
  can run a whole outreach session ("who's next? draft them.")
- `set_network_status` — promote/demote (active ⇄ prospect ⇄ archive)
- `schedule_email` / `create_follow_up_sequence` — reuse scheduled-send +
  sequence tables; auto-cancel-on-reply already handled by the cron
- `list_scheduled_emails`, `cancel_scheduled_email`

**Relationship upkeep**
- `log_interaction` — "just had a call with X, log it" (activates tier, per
  policy)
- `create_action_item` / `complete_action_item` / `list_action_items`
  (incl. waiting-on) — Claude becomes a CLI for the follow-up system
- `list_due_followups` — who's overdue on cadence right now
- `network_health` — the home-page stats (streak, neglected contacts,
  on-track ratio) for "how am I doing?" check-ins

**Research & intel**
- `get_company` — who works there (now/past, by office), target-company
  priority, recruiting-intel log entries
- `add_intel_note` — append to a company's recruiting log after a call
- `search_email_history` — full-text over cached messages ("what did Tim
  say about referrals?")
- `add_contact` — create a contact from fields or a LinkedIn URL (reusing
  bulk-import mapping for consistency)

**Calendar (scopes already granted)**
- `list_meetings(range)` with contact context
- `create_meeting` — Calendar event + Meet link + attendee invite, linked to
  the contact (which activates tier, per policy)

**Deliberately excluded**: AI generation tools (suggestion engine, email
writer). Claude *is* the generator — the MCP server should expose data and
actions, not compete with the model on prose.

## Safety & guardrails

- Read tools: unrestricted. Write tools: annotated `destructiveHint` where
  apt so Claude Code's permission prompts do their job.
- `send_email` requires `confirm: true` and re-checks the daily cap
  server-side — a runaway loop can't torch deliverability.
- Service-role key never leaves the local process; `.mcp.json` contains no
  secrets (env file is read at startup).
- Single-user by construction: every query is scoped to
  `CAREERVINE_USER_ID`; the server refuses to start without it.
- All writes go through the same lib functions as the app, so policies
  (bounce handling, reply-based graduation, caps) stay in one place.

## Implementation steps

1. Scaffold `careervine-mcp/` package (SDK, tsx, tsconfig alias into app src).
2. `lib/env.ts` — load + validate env from `careervine/.env.local`.
3. Extract `sendTrackedEmail()` from the send route into a shared lib module;
   route becomes a thin wrapper (keeps Vitest coverage green, add tests for
   the extracted function).
4. Add `createDraft()` to `lib/gmail.ts` (+ test with mocked gmail client).
5. Implement the four MVP tools; dossier assembled from existing queries with
   a token-conscious shape (cap interaction/email history at ~10 each,
   summaries not bodies).
6. `.mcp.json` at repo root; README section: setup, env requirements,
   example prompts.
7. Manual verification: `claude mcp list` → search → dossier → draft →
   confirm draft appears in Gmail; send test to self.
8. Phase 2 tools incrementally, one PR each, prioritized by actual usage.

## Open questions for Dawson

1. Should `send_email` exist at all in v1, or drafts-only until trust is
   built? (Plan assumes it exists but is confirm-gated.)
2. Dossier size: full history vs. recent-N? (Plan assumes recent-N with
   counts, expandable via a `depth` param later.)
3. Any interest in exposing this beyond Claude Code later (Claude Desktop
   uses the same stdio config) — affects nothing now, just naming.

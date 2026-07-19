# CAR-165 — Privacy policy: state with whom Google user data is shared

## Why

Google OAuth verification (CAR-111) is blocked on exactly one check: "Your privacy policy does not state with whom you share, transfer, or disclose Google user data." All other checks (homepage, app functionality, branding, minimum scopes) passed on Jul 18, 2026.

## What

Single-file copy change to `careervine/src/app/privacy/page.tsx`:

1. New **Section 6, "How We Share Google User Data"** — explicitly defines Google user data (Gmail messages/metadata, Calendar events, Gmail address/aliases, OAuth tokens) and enumerates every recipient:
   - Service providers acting as processors: Supabase (database, encrypted token storage), Vercel (app hosting, data in transit).
   - At the user's direction: Gmail recipients of sent emails; third-party AI assistants connected via the MCP integration (subjects, previews, sender/recipient addresses, calendar events), gated on the OAuth consent screen.
   - Legal reasons; business transfers (with notice).
   - Explicit negatives: no sale, no advertisers/data brokers, Gmail content and calendar events never sent to OpenAI or included in PostHog analytics, never used for model training.
2. Cross-reference from the Section 2 "Google Account Data" subsection.
3. Renumber old sections 6–10 to 7–11; bump "Last updated" to July 19, 2026.

## Grounding

Disclosure wording was verified against actual code flows before writing (Explore agent audit): OpenAI prompt builders read only contact/meeting/notes/transcript tables, never `email_messages` or `calendar_events`; PostHog events carry metadata only; QStash/Apify/Deepgram/Serper receive no Google data; MCP tools return Gmail subject/snippet/addresses and calendar events to connected clients; Resend digests carry no inbound Gmail content. A draft claim that MCP access is revocable "from your settings" was removed after confirming no such UI exists.

## Verification

- `npm run test` from `careervine/` (full Vitest suite) — passing, 1882/1882.
- No schema, no behavior change; docs page (docs.careervine.app) does not describe data-sharing practices, so no docs copy update needed.
- Rule 35 respected: no em dashes in the new user-facing copy.

## After merge

Merge deploys the page via Vercel. Dawson then replies to the Google Trust and Safety email thread (manual step on CAR-111/CAR-165).

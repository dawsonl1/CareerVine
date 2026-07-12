# CAR-100 — Connect Gmail + Calendar on a single Google consent screen

## Goal
A user grants Gmail and Google Calendar in **one** trip through Google's consent
screen (and the "unverified app" warning) instead of two. Both are sensitive
scopes, so bundling them changes nothing about verification or CASA — only the
paid `gmail.modify` scope is restricted, and it stays on its own conditional path.

## Part 1 — Always request both scopes together
- `api/gmail/auth/route.ts`: `includeCalendar` is now always `true` (dropped the
  `?scopes=calendar` conditional). Premium `gmail.modify` preservation and
  `returnTo` are untouched.
- `api-schemas.ts`: removed the now-unused `scopes` query param.
- Collapsed every connect CTA to a single "Connect Gmail & Calendar" action:
  setup banner, settings (Gmail card is the combined CTA; the Calendar card
  points to it when neither is connected), onboarding connect step, inbox empty
  state, company-page nudge. Contextual prompts (today-schedule, availability
  error) route to Settings, which is fine.

## Part 2 — Granular-consent hardening (false "connected" state)
Google's combined screen has per-scope checkboxes, so a user can grant Calendar
while unchecking Gmail. Gmail + Calendar **share one `gmail_connections` row**, so
"Gmail connected" could no longer be inferred from the row existing.

- Migration `20260712060000_gmail_send_scope_granted.sql`: adds
  `send_scope_granted boolean NOT NULL DEFAULT true` (existing rows all had send)
  + a CAR-27 column grant so the browser can read this non-secret UX flag.
- Callback records `send_scope_granted` from the actually-granted scopes
  (`gmail.send`/`gmail.modify`/full-mail all count as send-capable) and only
  fires the `gmail_connected` analytics event when send was granted.
- "Gmail connected" now gates on `send_scope_granted` at its three source
  derivations: `compose-email-context` (`gmailConnected`), the onboarding
  connect step, and the settings Gmail card. Downstream consumers read from
  these, so no per-consumer changes needed.

### Decision: skipped `include_granted_scopes`
It solves a different, rarer problem (token downgrade when a user *deliberately*
unchecks a previously-granted scope on re-consent). The stated problem — a
Calendar-only grant reading as "Gmail connected" — is fully solved by the
`send_scope_granted` flag. Left out to keep the OAuth token behavior unchanged.

## Verification
- `npm run test` (1365 pass, incl. a new calendar-only case in the MCP-placement
  test) and `npm run build` green.
- Migration is additive on an existing table (no dropped-schema references);
  applied on merge per rule 27.

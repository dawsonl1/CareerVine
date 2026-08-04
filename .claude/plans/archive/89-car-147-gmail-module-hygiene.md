# CAR-147 — gmail.ts module hygiene: break the circular import, swap googleapis for per-API subpackages, dependency cleanup

Wave 3 · T10. Retires findings F51, F52, F37, R3.1 of the Straight A's audit (CAR-28).

## Problem

- `gmail.ts` ↔ `email-send.ts` hold a comment-guarded **circular import** with mid-file
  imports (gmail.ts:183-189, incl. the `Circular with email-send.ts` warning at :186).
- The two highest-frequency crons (`send-follow-ups` */10, `send-scheduled-emails` */15)
  pay module-init cost for the **monolithic `googleapis`** package on every cold start.
- `email-send.ts`'s header (lines 1-18) **lies**: it claims cron deliveries call `sendEmail()`
  directly and are NOT capped. In reality both crons route through `sendTrackedEmail` and
  defer on `SendPolicyError` (verified: `send-follow-ups/route.ts:314`, `gmail.ts` `processScheduledEmails`).
- `@types/dompurify` is a redundant dependency (dompurify 3.3.3 ships its own types via its
  `exports` map). No `.github/dependabot.yml` exists.

## Design

### F51 — new leaf module `src/lib/gmail-send-core.ts`

The circular edge exists because `sendEmail` (in gmail.ts) is needed by `email-send.ts`,
while gmail.ts needs `sendTrackedEmail` (in email-send.ts). Break it by extracting the
low-level send primitives into a **true leaf** that imports neither gmail.ts nor email-send.ts.

Move into `gmail-send-core.ts`:
- `ComposeEmailOptions`
- `sanitizeHeaderValue`, `encodeHeaderValue`, `ENCODED_WORD_MAX_BYTES` (CAR-143-hardened; carried intact)
- `buildMimeMessage`
- `getConnection`
- `getGmailClient` — **necessary companion**: `sendEmail` depends on it, so for the leaf to
  import nothing from gmail.ts, the Gmail-client factory must live here too. (The ticket's
  4-symbol list is email-send's minimum; getGmailClient is the transitive dependency that
  makes the leaf actually leaf. Alternative — injecting the client into sendEmail — would
  churn every call site for no benefit.)
- `sendEmail`

Leaf imports only: `@googleapis/gmail`, `@/lib/oauth-helpers`, `@/lib/supabase/service-client`.

Resulting acyclic graph:
```
gmail-send-core.ts  (leaf)
   ▲            ▲
   │            │
email-send.ts   gmail.ts ──▶ email-send.ts   (one-directional; no cycle)
```

`gmail.ts` after: delete the `import { google } from "googleapis"` (its only use, `google.gmail`
in getGmailClient, moved out); hoist the mid-file imports (183-189) to the top block; delete
the circular-import comment; import `getGmailClient, getConnection, buildMimeMessage, type
ComposeEmailOptions` from core (used by `createDraft` + the sync functions), and keep importing
`sendTrackedEmail, SendPolicyError` from email-send (used by `processScheduledEmails`).
`createDraft` stays in gmail.ts (built on core primitives). Result: gmail.ts has zero imports
below ~line 30.

**Importers to repoint** (moved symbols → core):
- `email-send.ts` → `sendEmail, getConnection, ComposeEmailOptions` from core
- `contact-email-history.ts` → split: `getConnection` from core, `syncEmailsForContact` from gmail
- `app/api/cron/send-follow-ups/route.ts` → split: `getGmailClient` from core, `activateContactByEmail` from gmail
- `app/api/gmail/inbox/route.ts` → `getConnection` from core
- `app/api/gmail/emails/route.ts` → split: `getConnection` from core, `syncEmailsForContact, backfillEmailsForContact` from gmail

### F52 — rewrite `email-send.ts` header

State the real policy: every outbound path — interactive `/api/gmail/send`, MCP `send_email`,
the scheduled-email cron, and the follow-up cron — flows through `sendTrackedEmail`, so send
policy (daily cap, bounce refusal, pattern-guess warning, cache + interaction log) can't drift
between surfaces. Crons don't bypass the cap; they catch `SendPolicyError` and **defer** (429
cap → stop batch / revert to pending, retry next tick; 422 bounce → leave pending, detectBounces
cancels once the NDR lands). Keep the accurate "no tier auto-graduation" note. No em dashes
(rule 35) since this is a source comment — actually source comments are exempt, but keep it clean.

### R3.1 — swap `googleapis` → per-API subpackages

| File | before | after |
|---|---|---|
| `gmail-send-core.ts` | `google.gmail({version:"v1",auth})` | `gmail({version:"v1",auth})` from `@googleapis/gmail` (`gmail_v1.Gmail` type) |
| `calendar.ts` | `google.calendar({version:"v3",auth})` | `calendar({version:"v3",auth})` from `@googleapis/calendar` |
| `oauth-helpers.ts` | `new google.auth.OAuth2(...)` | `new OAuth2Client(...)` from `google-auth-library` |
| `gmail/callback/route.ts` | `google.oauth2({version:"v2",auth})` | `oauth2({version:"v2",auth})` from `@googleapis/oauth2` |

`@googleapis/oauth2` is a 4th subpackage beyond the ticket's three because callback's userinfo
fallback uses `google.oauth2`; it's an interactive OAuth route (not a cron bundle), so a small
extra subpackage is preferable to hand-rolling a `fetch`. `google-auth-library` becomes a direct
dep (oauth-helpers imports it directly; today it's only transitive via googleapis).

package.json: remove `googleapis`; add `@googleapis/gmail`, `@googleapis/calendar`,
`@googleapis/oauth2`, `google-auth-library`.

### F37 — deps + dependabot

- Remove `@types/dompurify` (dompurify ships types; verify via typecheck).
- Add `.github/dependabot.yml`: weekly, grouped npm updates for `/careervine`, `/careervine-mcp`,
  `/chrome-extension/panel-app`, plus `github-actions` (all three dirs confirmed to have package.json).

### Test mock updates (breakage is expected and must be repaired)

- `googleapis` module mock → `@googleapis/gmail`: `gmail-sync`, `gmail-drafts`, `gmail-auth-scopes`.
- Moved-symbol `@/lib/gmail` mocks → `@/lib/gmail-send-core`: `email-send` (sendEmail, getConnection),
  `send-route` (sendEmail, getConnection), `send-follow-ups-tier` (getGmailClient; split from
  activateContactByEmail which stays on gmail), `contact-email-history-tier` (getConnection; split
  from syncEmailsForContact), `gmail-emails-route-tier` (getConnection; split from sync/backfill).
- Untouched (mock only stayed symbols): `gmail-auth-route` (getAuthUrl), `mark-replied-route`
  (activateContactByEmail).

## Verification / Exit criteria

1. `rg 'from "googleapis"' careervine/src` empty; `googleapis` + `@types/dompurify` gone from package.json.
2. No gmail↔email-send cycle: prove core imports neither, and email-send doesn't import gmail
   (grep proof + `npx madge --circular` if reachable). gmail.ts imports all at top.
3. `npm run test`, `npm run build`, `npm run typecheck` all green from `careervine/`.
4. dependabot.yml validates (YAML) and lands so its first PRs trigger CI (`.github/workflows/ci.yml`).
5. Behavioral smoke where feasible (build proves the subpackage swap compiles + traces out of bundles).

## Then

Open the PR, run `/deep-review-pr` on the whole PR, and auto-fix every verified finding
(including nits) inside this PR/ticket until the branch is confidently mergeable.

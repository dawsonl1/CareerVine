# CAR-115 — Outreach: click a sent email to expand and read the full body

## Problem

Free-tier users see the **Outreach** portal (`/inbox` → `OutreachShell`). Its "Sent"
tab lists sent threads but can't be expanded to read what was actually sent. Two
blockers, both real:

1. The paid Inbox expands a message by **live-fetching** it from Gmail
   (`GET /api/gmail/emails/{id}`), which needs the `gmail.modify` read scope. Free
   users hold only `gmail.send`, so that path 403s. That's why the shell's header
   comment says "no body-expand."
2. On send (`email-send.ts:sendTrackedEmail`), the app **discards the body** and
   stores only a 200-char, HTML-stripped `snippet` in `email_messages`. No full
   body is persisted anywhere a free user can reach.

**Decision (Dawson, 2026-07-14):** persist the full sent body going forward, then
render it inline on expand. Older emails (no stored body) fall back to the snippet.

## Design

The whole Sent tab is already fed by the DB-only `/api/gmail/inbox` payload the shell
loads once. If we persist the body onto the `email_messages` row, it rides along in
that payload and the row expands **instantly with no extra fetch and no failure
mode** — the best UX and the least moving parts. One nullable column + one write-site
+ a UI toggle.

### 1. Migration (`supabase/migrations/20260714000000_add_body_html_to_email_messages.sql`)
- `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS body_html text;`
- Comment explaining it's the full outbound body, null for older/inbound/sync rows.
- Regenerate is not possible pre-merge (column not in prod yet), so hand-add
  `body_html: string | null` to the `email_messages` Row in `database.types.ts`
  (Insert/Update derive from Row automatically). Matches on the next real regen.

### 2. Persist on send (`src/lib/email-send.ts`)
- In the `email_messages` upsert, add `body_html: opts.bodyHtml || null`.
- **Single write-site covers every outbound path** — verified all converge here:
  - Interactive compose/send → `/api/gmail/send` → `sendTrackedEmail`
  - MCP `send_email` tool → `sendTrackedEmail`
  - Scheduled-email cron → `processScheduledEmails` (`gmail.ts:901`) → `sendTrackedEmail`
  - Follow-up cron → `send-follow-ups/route.ts:240` → `sendTrackedEmail`
- Gmail-sync rows (paid only) still store just the snippet — fine, paid users live-fetch.

### 3. Payload — no change
- `/api/gmail/inbox` already `select("*")`, so `body_html` is returned automatically.
- `EmailMessage` = the `email_messages` Row, so the type picks it up after step 1.

### 4. UI (`src/components/email/outreach/outreach-shell.tsx`, `SentList`)
- Track `expandedThreadId` in `SentList`.
- Restructure the row so the subject/recipient block is the expand toggle
  (`aria-expanded`, chevron affordance) and the **Reply button stays a sibling, not
  nested** (avoid button-in-button). Date + Reply stay on the right.
- When expanded, render each outbound message in `t.messages` (already oldest→newest):
  - `body_html` present → `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}`
    with the same `prose` classes the Inbox uses.
  - else `snippet` → plaintext paragraph.
  - else → muted "Message text wasn't saved for this email."
  - Show a small per-message date header when the thread has >1 message.
- Update the file's header comment (no longer strictly "no body-expand" — we now
  expand from persisted DB bodies, still with zero live mailbox read).

## Tests (rules 3, 4)
- `src/__tests__/email-send.test.ts` — assert the upsert payload includes `body_html`
  equal to the sent `bodyHtml`.
- `src/__tests__/outreach-shell.test.tsx` — a sent thread with `body_html` expands to
  show the body on click; a row with only `snippet` shows the snippet fallback.
- `npm run test` + `npm run build` from `careervine/`.

## Docs (rule 34)
- Check `public/docs/index.html` "Write outreach" / follow-up sections. This adds a
  re-read capability to the Outreach portal; add a light mention only if the page
  already describes the Sent/Outreach surface at that granularity.

## Out of scope
- Paid Inbox expand path (untouched; keeps live Gmail fetch).
- Lazy per-message body endpoint (viable future optimization if payload size ever
  matters; not needed for free-tier volume).

## Migration apply (rule 27)
- On merge: `supabase db push --dry-run` → review → `supabase db push`.

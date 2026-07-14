-- CAR-115: persist the full HTML body of a sent (outbound) message.
--
-- The free-tier Outreach portal (CAR-102) is DB-only — free users hold only the
-- gmail.send scope, so the paid Inbox's live body fetch (GET /api/gmail/emails/{id})
-- is unavailable to them. Until now the send path stored only a 200-char, HTML-
-- stripped `snippet`, so there was no way to re-read what was actually sent.
--
-- This column lets sendTrackedEmail() persist `opts.bodyHtml` at send time. Every
-- outbound path (interactive compose/send, MCP send_email, scheduled-email cron,
-- follow-up cron) converges on sendTrackedEmail, so one write-site fills it.
--
-- Nullable by design: rows sent before this migration, inbound messages, and
-- Gmail-sync rows have no persisted body and fall back to `snippet` in the UI.

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS body_html text;

COMMENT ON COLUMN public.email_messages.body_html IS
  'CAR-115: full HTML body of an outbound message, persisted at send time so free-tier Outreach users can re-read what they sent without a live Gmail read. Null for pre-CAR-115 rows, inbound messages, and sync-created rows (UI falls back to snippet).';

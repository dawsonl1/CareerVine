-- CAR-100: Gmail and Calendar now share a single Google consent screen. Google's
-- granular consent lets a user grant Calendar while UNCHECKING Gmail, so whether
-- Gmail is connected can no longer be inferred from the connection row existing
-- (that row is shared with Calendar). Track the Gmail send scope explicitly and
-- gate the "Gmail connected" UI on it instead of on row existence.
--
-- DEFAULT true: every existing connection was created by a flow that always
-- requested gmail.send, so existing rows are correctly send-capable. The OAuth
-- callback overwrites this with the real granted-scope fact on the next connect.
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS send_scope_granted boolean NOT NULL DEFAULT true;

-- The browser reads connection metadata through a column-scoped grant (CAR-27,
-- 20260710100000). send_scope_granted is a non-secret UX flag — it gates the
-- "Connect Gmail" prompt, never any actual send authorization (that stays
-- server-side in getGmailClient) — so expose it alongside the other render
-- metadata. New columns are NOT covered by an existing column-level grant, so
-- this GRANT is required for getGmailConnection to read it.
GRANT SELECT (send_scope_granted) ON public.gmail_connections TO authenticated;

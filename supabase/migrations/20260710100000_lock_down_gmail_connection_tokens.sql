-- CAR-27: gmail_connections stores Google OAuth tokens. The browser client
-- must never be able to read them — a stolen session (XSS, extension,
-- shared-machine devtools) would otherwise exfiltrate live Gmail credentials.
--
-- All mutations and token reads go through the service-role client, so the
-- authenticated role keeps only a column-scoped SELECT for the connection
-- metadata the UI renders. Token encryption at rest is handled in app code
-- (same AES-256-GCM helper as user_api_keys); no schema change needed.

-- Client mutations were never used — every write is service-role.
DROP POLICY IF EXISTS "Users can insert their own gmail connection" ON gmail_connections;
DROP POLICY IF EXISTS "Users can update their own gmail connection" ON gmail_connections;
DROP POLICY IF EXISTS "Users can delete their own gmail connection" ON gmail_connections;

-- Column-level lockdown: revoke everything, then grant back SELECT on only
-- the metadata columns the browser reads (queries.ts getGmailConnection).
-- user_id stays granted — the RLS predicate and the client filter need it.
REVOKE ALL ON gmail_connections FROM anon, authenticated;
GRANT SELECT (id, user_id, gmail_address, last_gmail_sync_at, created_at)
  ON gmail_connections TO authenticated;

-- The "Users can view their own gmail connection" SELECT policy stays: it
-- scopes rows to auth.uid(), while the grant above scopes columns.
-- The service-role policy stays; service_role also bypasses RLS outright.

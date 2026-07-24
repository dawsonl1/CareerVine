-- CAR-172: reset Gmail ingestion sync state when a contact's address set changes.
--
-- 1. contacts.email_backfilled_at — completion stamp for backfillEmailsForContact
--    (the cached-message claim + junction-link pass). Lets the per-page-view
--    call no-op on a warm contact instead of full-scanning email_messages on
--    every GET /api/gmail/emails (CAR-106-class compute).
-- 2. Trigger on contact_emails — a contact gaining (or changing) an address
--    nulls BOTH email_synced_through and email_backfilled_at, so the next sync
--    re-covers the full window for the new address and the next page view
--    re-runs the backfill. This is the write chokepoint: five app paths insert
--    contact_emails rows (data-layer, bulk import x2, bundle fast-apply, admin
--    route), so app-level resets could always be skipped — same reasoning as
--    the CAR-153 normalize_contact_email trigger on this table.
--
-- The disconnect-side reset (revokeAccess deleting the cache a watermark
-- points into) is app code, not schema — see careervine/src/lib/gmail.ts.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_backfilled_at timestamptz;
COMMENT ON COLUMN contacts.email_backfilled_at IS
  'Completion stamp for the cached-email claim/junction backfill (backfillEmailsForContact). NULL = never completed or address set changed since; the per-page-view backfill skips contacts stamped within its staleness window. Reset to NULL by the contact_emails_reset_sync_state trigger.';

COMMENT ON COLUMN contacts.email_synced_through IS
  'Gmail sync watermark: history is fully cached through this instant. Written only when a sync pass completes without throwing; NULL = never fully synced (fall back to the sinceDays window). Reset to NULL when the contact gains an address (contact_emails_reset_sync_state trigger) and on Gmail disconnect (revokeAccess), so the deleted/never-fetched span is re-covered.';

-- Invoker-rights (no SECURITY DEFINER): any writer allowed to insert a
-- contact_emails row for a contact is allowed to update that contact under
-- RLS, and the service-role writers bypass RLS anyway. AFTER trigger: the
-- reset is a side effect on the parent row, not a mutation of NEW.
CREATE OR REPLACE FUNCTION reset_contact_email_sync_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a genuine address change resets; source/is_primary/bounced_at
  -- updates re-fire the UPDATE OF email trigger path only when the email
  -- column is listed, but guard anyway so an unchanged address is a no-op.
  IF TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email THEN
    RETURN NEW;
  END IF;
  UPDATE contacts
     SET email_synced_through = NULL,
         email_backfilled_at = NULL
   WHERE id = NEW.contact_id
     AND (email_synced_through IS NOT NULL OR email_backfilled_at IS NOT NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_emails_reset_sync_state ON contact_emails;
CREATE TRIGGER contact_emails_reset_sync_state
  AFTER INSERT OR UPDATE OF email ON contact_emails
  FOR EACH ROW
  EXECUTE FUNCTION reset_contact_email_sync_state();

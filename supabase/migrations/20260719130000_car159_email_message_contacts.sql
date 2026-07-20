-- CAR-159: multi-contact email attribution (retires audit finding R2.7)
--
-- email_messages.matched_contact_id is single-valued, so a thread involving
-- two tracked contacts (intro email: recruiter + hiring manager) was
-- attributed only to whichever contact synced first. This junction mirrors
-- calendar_event_contacts; matched_contact_id stays as the denormalized
-- primary during the transition (display readers and reply attribution keep
-- using it), while per-contact readers move to the junction.

-- ── Table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_message_contacts (
  email_message_id INTEGER NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  contact_id       INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (email_message_id, contact_id)
);

-- The PK serves message→contacts; this serves the hot per-contact direction.
CREATE INDEX IF NOT EXISTS idx_email_message_contacts_contact_id
  ON email_message_contacts(contact_id);

-- ── RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE email_message_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own email message contacts" ON email_message_contacts;
CREATE POLICY "Users can manage own email message contacts"
  ON email_message_contacts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM email_messages em
      WHERE em.id = email_message_id AND em.user_id = auth.uid()
    )
  );

-- Service-role policy, matching the gmail-table family's convention.
DROP POLICY IF EXISTS "Service role has full access to email_message_contacts" ON email_message_contacts;
CREATE POLICY "Service role has full access to email_message_contacts"
  ON email_message_contacts FOR ALL
  USING (auth.role() = 'service_role');

-- ── Backfill 1: preserve every existing single-contact attribution ──────

INSERT INTO email_message_contacts (email_message_id, contact_id)
SELECT id, matched_contact_id
FROM email_messages
WHERE matched_contact_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Backfill 2: address-based repair (the actual R2.7 fix for history) ──
--
-- Link every cached message to EVERY same-user contact whose address appears
-- in from_address or to_addresses. Reliable because CAR-153 normalized
-- contact_emails.email to lower(trim()) with a chokepoint trigger;
-- from_address/to_addresses are lowercased by parseEmailAddress on write but
-- lower() is applied anyway for rows predating that convention.

INSERT INTO email_message_contacts (email_message_id, contact_id)
SELECT DISTINCT em.id, ce.contact_id
FROM email_messages em
JOIN contacts c   ON c.user_id = em.user_id
JOIN contact_emails ce ON ce.contact_id = c.id AND ce.email IS NOT NULL
WHERE lower(em.from_address) = ce.email
   OR EXISTS (
        SELECT 1 FROM unnest(em.to_addresses) AS t(addr)
        WHERE lower(t.addr) = ce.email
      )
ON CONFLICT DO NOTHING;

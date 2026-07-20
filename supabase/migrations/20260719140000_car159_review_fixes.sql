-- CAR-159 deep-review fixes (F1 + F2). Separate migration because
-- 20260719130000 was already applied to production (rule 42 early apply), so
-- these corrections cannot be folded into it without schema drift.

-- ── F2: tighten email_message_contacts RLS to check BOTH ownership legs ──
--
-- The original policy gated only on email_messages ownership (USING reused as
-- the implicit WITH CHECK for INSERT). An authenticated user hitting PostgREST
-- directly with their own JWT could therefore link one of their own messages to
-- ANOTHER user's contact — verified empirically against the hosted instance.
-- No data is disclosed (every app reader hand-scopes on email_messages.user_id
-- and all writers use the service-role client, which bypasses RLS), but the
-- write should still be refused: a contact link must reference a contact the
-- caller owns. Add the contacts-ownership leg to both USING and WITH CHECK.

DROP POLICY IF EXISTS "Users can manage own email message contacts" ON email_message_contacts;
CREATE POLICY "Users can manage own email message contacts"
  ON email_message_contacts FOR ALL
  USING (
    EXISTS (SELECT 1 FROM email_messages em WHERE em.id = email_message_id AND em.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM email_messages em WHERE em.id = email_message_id AND em.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = auth.uid())
  );

-- ── F1: repair the migration-apply → code-deploy gap ────────────────────
--
-- 20260719130000's backfill ran once, at apply time. Until the CAR-159 code
-- deploys, the still-running OLD code keeps inserting email_messages rows
-- (sync, sends, manual replies) with matched_contact_id set but NO junction
-- row, and the new junction-only readers would hide those rows permanently.
-- Re-running the identical idempotent backfill after the new code is live
-- captures every gap-window row in one pass (old code has stopped writing
-- them by then). Both statements are the same as 20260719130000's; ON CONFLICT
-- DO NOTHING makes the re-run free for rows already linked.
--
-- APPLY-AFTER-DEPLOY: this migration must be pushed only once the merged CAR-159
-- code is serving (wait-for-deploy exit 0). Applied earlier, the OLD code would
-- write more gap rows after the backfill and re-open the hole.

INSERT INTO email_message_contacts (email_message_id, contact_id)
SELECT id, matched_contact_id
FROM email_messages
WHERE matched_contact_id IS NOT NULL
ON CONFLICT DO NOTHING;

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

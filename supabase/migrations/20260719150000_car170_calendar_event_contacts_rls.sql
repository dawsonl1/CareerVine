-- CAR-170: harden calendar_event_contacts RLS to check BOTH ownership legs.
--
-- Same class as the CAR-159 email_message_contacts fix (20260719140000). The
-- original policy (20260218090000) gated only on calendar_events ownership;
-- USING is reused as the implicit WITH CHECK for INSERT, so an authenticated
-- user hitting PostgREST directly with their own JWT could link one of their
-- own events to ANOTHER user's contact. No data is disclosed (every app reader
-- hand-scopes on the parent's user_id and all writers use the service-role
-- client), but the write should still be refused: a link must reference a
-- contact the caller owns. Verified empirically against the hosted instance,
-- mirroring the CAR-159 verification.

DROP POLICY IF EXISTS "Users can manage own calendar event contacts" ON calendar_event_contacts;
CREATE POLICY "Users can manage own calendar event contacts"
  ON calendar_event_contacts FOR ALL
  USING (
    EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = calendar_event_id AND ce.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = calendar_event_id AND ce.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = auth.uid())
  );

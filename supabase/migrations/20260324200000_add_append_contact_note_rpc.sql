-- Atomic append to contact notes, avoiding read-then-write race conditions
CREATE OR REPLACE FUNCTION append_contact_note(p_contact_id int, p_note text)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE contacts
  SET notes = CASE
    WHEN notes IS NULL OR notes = '' THEN p_note
    ELSE notes || E'\n\n' || p_note
  END
  WHERE id = p_contact_id;
$$;

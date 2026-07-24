-- CAR-178: close one-leg RLS gaps on junction tables.
--
-- CAR-159's deep review (F2) found email_message_contacts gated only on the
-- message leg, letting an authenticated user hitting PostgREST directly link
-- their own message to ANOTHER user's contact; the fix added the contacts leg
-- to USING and WITH CHECK. The integration tier being built for CAR-178
-- surfaced the same class of gap on six sibling junctions: each checks only
-- one parent's ownership, leaving the other parent cross-tenant referencable.
--
-- As with CAR-159 F2, no data is disclosed (reading the referenced row is
-- still blocked by that table's own RLS, and app writers either use the
-- service client or only ever pass the user's own ids), but the write should
-- still be refused: a junction row must reference parents the caller owns on
-- BOTH legs. This migration rewrites each policy with both ownership legs,
-- keeping existing policy names and per-command shapes.
--
-- The integration tier (careervine/src/__integration__/rls-tenant-isolation
-- .itest.ts) asserts both legs on every junction, so a regression here goes
-- red in CI rather than waiting for a human review.

-- ── meeting_contacts: add the contacts leg ──────────────────────────────

DROP POLICY IF EXISTS "meeting_contacts_select" ON meeting_contacts;
CREATE POLICY "meeting_contacts_select" ON meeting_contacts FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "meeting_contacts_insert" ON meeting_contacts;
CREATE POLICY "meeting_contacts_insert" ON meeting_contacts FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "meeting_contacts_delete" ON meeting_contacts;
CREATE POLICY "meeting_contacts_delete" ON meeting_contacts FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
  );

-- ── action_item_contacts: add the contacts leg ──────────────────────────

DROP POLICY IF EXISTS "Users can manage their action item contacts" ON action_item_contacts;
CREATE POLICY "Users can manage their action item contacts" ON action_item_contacts FOR ALL
  USING (
    EXISTS (SELECT 1 FROM follow_up_action_items ai WHERE ai.id = action_item_id AND ai.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM follow_up_action_items ai WHERE ai.id = action_item_id AND ai.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
  );

-- ── contact_tags: add the tags leg ──────────────────────────────────────

DROP POLICY IF EXISTS "contact_tags_select" ON contact_tags;
CREATE POLICY "contact_tags_select" ON contact_tags FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM tags t WHERE t.id = tag_id AND t.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "contact_tags_insert" ON contact_tags;
CREATE POLICY "contact_tags_insert" ON contact_tags FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM tags t WHERE t.id = tag_id AND t.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "contact_tags_delete" ON contact_tags;
CREATE POLICY "contact_tags_delete" ON contact_tags FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM tags t WHERE t.id = tag_id AND t.user_id = (SELECT auth.uid()))
  );

-- ── contact_attachments: add the attachments leg ────────────────────────

DROP POLICY IF EXISTS "contact_attachments_select" ON contact_attachments;
CREATE POLICY "contact_attachments_select" ON contact_attachments FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "contact_attachments_insert" ON contact_attachments;
CREATE POLICY "contact_attachments_insert" ON contact_attachments FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "contact_attachments_delete" ON contact_attachments;
CREATE POLICY "contact_attachments_delete" ON contact_attachments FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = contact_id AND ct.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

-- ── meeting_attachments: add the attachments leg ────────────────────────

DROP POLICY IF EXISTS "meeting_attachments_select" ON meeting_attachments;
CREATE POLICY "meeting_attachments_select" ON meeting_attachments FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "meeting_attachments_insert" ON meeting_attachments;
CREATE POLICY "meeting_attachments_insert" ON meeting_attachments FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "meeting_attachments_delete" ON meeting_attachments;
CREATE POLICY "meeting_attachments_delete" ON meeting_attachments FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

-- ── interaction_attachments: add the attachments leg ────────────────────

DROP POLICY IF EXISTS "interaction_attachments_select" ON interaction_attachments;
CREATE POLICY "interaction_attachments_select" ON interaction_attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM interactions i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id = interaction_id AND c.user_id = (SELECT auth.uid())
    )
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "interaction_attachments_insert" ON interaction_attachments;
CREATE POLICY "interaction_attachments_insert" ON interaction_attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interactions i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id = interaction_id AND c.user_id = (SELECT auth.uid())
    )
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "interaction_attachments_delete" ON interaction_attachments;
CREATE POLICY "interaction_attachments_delete" ON interaction_attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM interactions i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id = interaction_id AND c.user_id = (SELECT auth.uid())
    )
    AND EXISTS (SELECT 1 FROM attachments a WHERE a.id = attachment_id AND a.user_id = (SELECT auth.uid()))
  );

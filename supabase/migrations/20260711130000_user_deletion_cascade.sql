-- CAR-66: Fix user deletion — the legacy core tables from init.sql
-- (20260201214637_init.sql) declared every FK with NO ON DELETE action, so it
-- defaulted to NO ACTION (RESTRICT). Deleting auth.users cascades into
-- public.users, but deleting that profile row is then blocked by every
-- *_user_fk on the core tables, aborting the whole cascade — auth.admin.deleteUser
-- returns an error and both the app and the Supabase dashboard report "failed".
--
-- 20260215050000_add_cascade_delete_to_contacts.sql fixed the contact->children
-- edges only. This migration fixes the remaining edges on the user-deletion path.
-- Every table added after init already cascades correctly, so nothing here
-- touches them. Edges to shared reference data (companies, schools) stay
-- RESTRICT — those rows are not deleted along with a user.
--
-- Re-adding these constraints revalidates against existing data, which already
-- satisfies them (we only change delete behavior), so this is fast on real data.

-- ── User-owned data → CASCADE when the owning user is deleted ────────────────
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_user_fk;
ALTER TABLE contacts ADD CONSTRAINT contacts_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_user_fk;
ALTER TABLE meetings ADD CONSTRAINT meetings_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_user_fk;
ALTER TABLE tags ADD CONSTRAINT tags_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_user_fk;
ALTER TABLE attachments ADD CONSTRAINT attachments_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_companies DROP CONSTRAINT IF EXISTS user_companies_user_fk;
ALTER TABLE user_companies ADD CONSTRAINT user_companies_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_schools DROP CONSTRAINT IF EXISTS user_schools_user_fk;
ALTER TABLE user_schools ADD CONSTRAINT user_schools_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_user_fk;
ALTER TABLE referrals ADD CONSTRAINT referrals_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE follow_up_action_items DROP CONSTRAINT IF EXISTS follow_up_action_items_user_fk;
ALTER TABLE follow_up_action_items ADD CONSTRAINT follow_up_action_items_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ── Meeting children → CASCADE (also unblocks standalone meeting deletion) ───
ALTER TABLE meeting_contacts DROP CONSTRAINT IF EXISTS meeting_contacts_meeting_fk;
ALTER TABLE meeting_contacts ADD CONSTRAINT meeting_contacts_meeting_fk
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

ALTER TABLE meeting_attachments DROP CONSTRAINT IF EXISTS meeting_attachments_meeting_fk;
ALTER TABLE meeting_attachments ADD CONSTRAINT meeting_attachments_meeting_fk
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE;

-- referral_meeting_id is nullable — drop the link, keep the referral.
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_meeting_fk;
ALTER TABLE referrals ADD CONSTRAINT referrals_meeting_fk
  FOREIGN KEY (referral_meeting_id) REFERENCES meetings(id) ON DELETE SET NULL;

-- NOTE: init.sql's post_meeting_action_items FKs are intentionally absent here —
-- that table was dropped in 20260214092500_drop_post_meeting_action_items.sql,
-- so its constraints no longer exist anywhere (verified against production).

-- ── Tag / attachment / interaction join rows → CASCADE ──────────────────────
ALTER TABLE contact_tags DROP CONSTRAINT IF EXISTS contact_tags_tag_fk;
ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_tag_fk
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE;

ALTER TABLE contact_attachments DROP CONSTRAINT IF EXISTS contact_attachments_attachment_fk;
ALTER TABLE contact_attachments ADD CONSTRAINT contact_attachments_attachment_fk
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE;

ALTER TABLE meeting_attachments DROP CONSTRAINT IF EXISTS meeting_attachments_attachment_fk;
ALTER TABLE meeting_attachments ADD CONSTRAINT meeting_attachments_attachment_fk
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE;

ALTER TABLE interaction_attachments DROP CONSTRAINT IF EXISTS interaction_attachments_attachment_fk;
ALTER TABLE interaction_attachments ADD CONSTRAINT interaction_attachments_attachment_fk
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE;

ALTER TABLE interaction_attachments DROP CONSTRAINT IF EXISTS interaction_attachments_interaction_fk;
ALTER TABLE interaction_attachments ADD CONSTRAINT interaction_attachments_interaction_fk
  FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE CASCADE;

-- ── Admin audit-ish ref → SET NULL (keep the override row, drop the admin link) ─
-- Inline unnamed FK from 20260709140000_admin_dashboard_foundation.sql; Postgres
-- auto-named it <table>_<column>_fkey.
ALTER TABLE bundle_access_overrides DROP CONSTRAINT IF EXISTS bundle_access_overrides_updated_by_fkey;
ALTER TABLE bundle_access_overrides ADD CONSTRAINT bundle_access_overrides_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

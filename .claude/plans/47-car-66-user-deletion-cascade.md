# CAR-66 — Fix user deletion (missing ON DELETE CASCADE on legacy core tables)

## Problem

Deleting a user fails everywhere — the admin dashboard (`DELETE /api/admin/users/[id]`)
and the Supabase dashboard's built-in delete both just say "failed". Reproduces for any
account that has ever created a contact, meeting, tag, or attachment (i.e. every real user).

## Root cause

`supabase/migrations/20260201214637_init.sql` adds every core-table FK with **no `ON DELETE`
action** (defaults to `NO ACTION`). Deleting `auth.users` cascades into `public.users`
(the profile FK cascades), but deleting that profile row is then blocked by the `*_user_fk`
constraints on `contacts`, `meetings`, `tags`, `attachments`, `user_companies`,
`user_schools`, `referrals`, `post_meeting_action_items`, `follow_up_action_items`. The
cascade aborts → `auth.admin.deleteUser` errors → "Delete failed".

`20260215050000_add_cascade_delete_to_contacts.sql` fixed only the **contact → children**
edges, never the user-facing ones. Every table added *after* init already cascades correctly.

## Fix — one migration, no app-code change

Re-create the 17 offending FKs (drop + add) with the correct action. (init.sql also created
three `post_meeting_action_items` FKs, but that table was dropped in
`20260214092500_drop_post_meeting_action_items.sql` — verified absent in production, so
they need no fix and must not be referenced.) Final actions:

| Constraint | Parent | Action | Why |
|---|---|---|---|
| contacts_user_fk | users | CASCADE | user-owned |
| meetings_user_fk | users | CASCADE | user-owned |
| tags_user_fk | users | CASCADE | user-owned |
| attachments_user_fk | users | CASCADE | user-owned |
| user_companies_user_fk | users | CASCADE | user-owned |
| user_schools_user_fk | users | CASCADE | user-owned |
| referrals_user_fk | users | CASCADE | user-owned |
| follow_up_action_items_user_fk | users | CASCADE | user-owned |
| meeting_contacts_meeting_fk | meetings | CASCADE | join row |
| meeting_attachments_meeting_fk | meetings | CASCADE | join row |
| referrals_meeting_fk | meetings | SET NULL | referral_meeting_id nullable — keep referral |
| contact_tags_tag_fk | tags | CASCADE | join row |
| contact_attachments_attachment_fk | attachments | CASCADE | join row |
| meeting_attachments_attachment_fk | attachments | CASCADE | join row |
| interaction_attachments_attachment_fk | attachments | CASCADE | join row |
| interaction_attachments_interaction_fk | interactions | CASCADE | join row |
| bundle_access_overrides_updated_by_fkey | users | SET NULL | nullable admin ref — keep override |

Cascade handles depth automatically once every edge on the path is CASCADE/SET NULL; edges
to shared reference data (`companies`, `schools`) stay RESTRICT — those aren't deleted with a user.

## Verification

- `supabase db push --dry-run` to confirm SQL applies cleanly.
- Post-apply (after merge): create a throwaway auth user with a contact + meeting + tag +
  attachment, delete it via `auth.admin.deleteUser`, confirm success and that child rows are gone.

## Out of scope

Cascade deletes the `attachments` *rows* but not the underlying storage blobs (R2 /
Supabase Storage). Orphan-blob cleanup is a separate follow-up.

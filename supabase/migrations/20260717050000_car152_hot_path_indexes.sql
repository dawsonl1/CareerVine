-- CAR-152 (R3.3): hot-path indexes. Each column set is verified against a
-- live query shape; existing indexes on these tables either lead with the
-- wrong column or interpose one that blocks the sort.

-- .eq/.in("contact_id") — mcp/lib/db.ts (timeline + counts),
-- lib/company-queries.ts, lib/bundle-sync.ts. FK has no index.
CREATE INDEX IF NOT EXISTS idx_interactions_contact_id
  ON interactions (contact_id);

-- .eq(user_id).eq(is_completed).order(due_at) — mcp/lib/db.ts action-item
-- list; the (user_id, is_completed) prefix also serves the completed-count
-- and onboarding-item probes. Table had no index at all.
CREATE INDEX IF NOT EXISTS idx_follow_up_action_items_user_open_due
  ON follow_up_action_items (user_id, is_completed, due_at);

-- .eq/.in("contact_id") — mcp/lib/db.ts, lib/company-queries.ts,
-- lib/bundle-sync.ts, api/gmail/ai-write/meetings. The unique index leads
-- with meeting_id, so contact-side lookups scan.
CREATE INDEX IF NOT EXISTS idx_meeting_contacts_contact_id
  ON meeting_contacts (contact_id);

-- .eq(user_id).order(date DESC) without a matched_contact_id filter —
-- mcp/lib/db.ts inbox list and outbound counts. The existing
-- (user_id, matched_contact_id, date DESC) index interposes
-- matched_contact_id, which blocks the date-ordered scan.
CREATE INDEX IF NOT EXISTS idx_email_messages_user_date
  ON email_messages (user_id, date DESC);

-- .in("email", ...) — calendar sync attendee matching — and .eq("email", ...)
-- in ai-write/resolve-contact. The unique index leads with contact_id, so
-- email-first lookups scan. (activateContactByEmail uses ILIKE, which a
-- plain btree cannot serve; it is NOT a beneficiary of this index.)
CREATE INDEX IF NOT EXISTS idx_contact_emails_email
  ON contact_emails (email);

-- .contains("to_addresses", [email]) — lib/gmail.ts
-- backfillEmailsForContact (orphaned-message claim); array containment
-- needs GIN.
CREATE INDEX IF NOT EXISTS idx_email_messages_to_addresses_gin
  ON email_messages USING gin (to_addresses);

-- CAR-153: Gmail ingestion correctness (retires audit findings R2.2, R2.5, R2.8)
--
-- 1. contacts.email_synced_through — per-contact COMPLETED-sync watermark.
--    The sync previously derived its resume point from max(cached email date),
--    but Gmail lists newest-first: an interrupted backfill caches the newest
--    page and the next run starts after it, leaving a permanent self-hiding
--    hole. The watermark is written only when a pagination pass completes.
-- 2. gmail_connections.send_as_aliases — lowercased send-as alias addresses
--    (users.settings.sendAs.list), so mail sent from an alias classifies as
--    outbound instead of a false inbound "reply". NULL = unknown (free/send-only
--    connections can't read settings) → primary address only.
-- 3. contact_emails.email normalization chokepoint — one-time lower(trim())
--    of existing rows (with a dedupe pass first, since lowercasing can collide
--    on the (contact_id, email) unique index) plus a BEFORE trigger so every
--    future writer lands normalized. Lets matchers use = instead of ILIKE.

-- ── 1. Per-contact completed-sync watermark ─────────────────────────────

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_synced_through timestamptz;
COMMENT ON COLUMN contacts.email_synced_through IS
  'Gmail sync watermark: history is fully cached through this instant. Written only when a sync pass completes without throwing; NULL = never fully synced (fall back to the sinceDays window).';

-- ── 2. Send-as alias set ────────────────────────────────────────────────

ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS send_as_aliases jsonb;
COMMENT ON COLUMN gmail_connections.send_as_aliases IS
  'Lowercased send-as addresses from users.settings.sendAs.list (jsonb string array). Used for direction classification and calendar attendee self-filtering. NULL = unknown; the primary gmail_address always counts regardless.';

-- ── 3. contact_emails normalization ─────────────────────────────────────

-- 3a. Dedupe rows that would collide once lowercased: within each
-- (contact_id, lower(trim(email))) group keep the primary (else oldest) row,
-- folding is_primary and the earliest bounced_at onto the keeper before the
-- losers are deleted. Nothing references contact_emails.id (verified against
-- the full migration chain), so the deletes cannot orphan anything.

WITH ranked AS (
  SELECT
    id,
    contact_id,
    lower(trim(email)) AS norm_email,
    row_number() OVER (
      PARTITION BY contact_id, lower(trim(email))
      ORDER BY is_primary DESC, id ASC
    ) AS rn
  FROM contact_emails
  WHERE email IS NOT NULL
),
merged AS (
  SELECT
    contact_id,
    norm_email,
    (SELECT r.id FROM ranked r
      WHERE r.contact_id = g.contact_id AND r.norm_email = g.norm_email AND r.rn = 1) AS keeper_id
  FROM ranked g
  GROUP BY contact_id, norm_email
  HAVING count(*) > 1
),
folded AS (
  SELECT
    m.keeper_id,
    bool_or(ce.is_primary) AS any_primary,
    min(ce.bounced_at) AS earliest_bounced_at
  FROM merged m
  JOIN ranked r ON r.contact_id = m.contact_id AND r.norm_email = m.norm_email
  JOIN contact_emails ce ON ce.id = r.id
  GROUP BY m.keeper_id
)
UPDATE contact_emails ce
SET is_primary = f.any_primary,
    bounced_at = COALESCE(ce.bounced_at, f.earliest_bounced_at)
FROM folded f
WHERE ce.id = f.keeper_id;

DELETE FROM contact_emails ce
USING (
  SELECT id FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY contact_id, lower(trim(email))
        ORDER BY is_primary DESC, id ASC
      ) AS rn
    FROM contact_emails
    WHERE email IS NOT NULL
  ) ranked
  WHERE rn > 1
) losers
WHERE ce.id = losers.id;

-- 3b. Lowercase the survivors.

UPDATE contact_emails
SET email = lower(trim(email))
WHERE email IS NOT NULL
  AND email <> lower(trim(email));

-- 3c. Chokepoint trigger: every future insert/update lands normalized, no
-- matter which writer produced it (app routes, bulk import, admin tooling).

CREATE OR REPLACE FUNCTION normalize_contact_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := lower(trim(NEW.email));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_emails_normalize_email ON contact_emails;
CREATE TRIGGER contact_emails_normalize_email
  BEFORE INSERT OR UPDATE OF email ON contact_emails
  FOR EACH ROW
  EXECUTE FUNCTION normalize_contact_email();

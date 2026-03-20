-- Add timestamp to track when contact_status was last derived/set.
-- Used for lazy re-derivation every January and July.
ALTER TABLE contacts ADD COLUMN status_derived_at timestamptz DEFAULT NULL;

-- Backfill existing contacts so they don't all re-derive on first access.
UPDATE contacts SET status_derived_at = now() WHERE contact_status IS NOT NULL;

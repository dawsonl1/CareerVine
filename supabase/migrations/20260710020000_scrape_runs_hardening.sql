-- Plan 29 (CAR-15) phase 1 hardening (deep-review fixes).
--
-- 1. Atomic single-in-flight guard: a partial unique index so two concurrent
--    triggers for the same contact can't both start a paid run (the app-level
--    read-then-insert check was a TOCTOU race). single_contact_id is the one
--    contact a run targets; the index only applies while the run is pending.
-- 2. sum_scrape_spend RPC: a server-side SUM for the monthly cap, so the cap
--    can't be under-counted by the JS client's 1000-row select ceiling.

ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS single_contact_id INT;

COMMENT ON COLUMN scrape_runs.single_contact_id IS 'The single contact this run targets (NULL for future multi-contact/cadence runs); backs the one-in-flight-per-contact guard';

CREATE UNIQUE INDEX IF NOT EXISTS scrape_runs_one_pending_per_contact
  ON scrape_runs (user_id, single_contact_id)
  WHERE status = 'pending' AND single_contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sum_scrape_spend(p_user_id uuid, p_since timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::numeric
  FROM scrape_runs
  WHERE user_id = p_user_id AND created_at >= p_since;
$$;

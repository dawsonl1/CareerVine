-- Plan 29 (CAR-15) phase 2/3 review fix: latest-snapshot-per-contact.
--
-- The diff engine needs each contact's MOST RECENT prior snapshot as its
-- baseline. A plain `.in(contact_id, …).order(scraped_at desc)` select is
-- capped at PostgREST's 1000-row ceiling; once a contact set accumulates >1000
-- historical snapshots, some contacts' latest rows fall off the page and the
-- diff sees prev=null → boolean/location/cert changes silently re-baseline.
-- DISTINCT ON returns exactly one (the newest) row per contact regardless.

CREATE OR REPLACE FUNCTION latest_contact_snapshots(p_contact_ids INT[])
RETURNS TABLE (contact_id INT, snapshot jsonb)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (s.contact_id) s.contact_id, s.snapshot
  FROM contact_scrape_snapshots s
  WHERE s.contact_id = ANY(p_contact_ids)
  ORDER BY s.contact_id, s.scraped_at DESC;
$$;

-- CAR-135 / R4.8: minimize retained third-party profile data on discovery
-- candidates the user is done with.
--
-- Once a discovery candidate is added (converted to a contact, which then holds
-- the profile data) or dismissed (sticky-hidden forever), the full scraped
-- payload is no longer needed: only the identity tombstone
-- (user_id, linkedin_url, name, status) is, for dedup and sticky dismiss.
--
-- Going forward the add/dismiss routes redact at the transition and the weekly
-- ingest no longer rewrites non-'new' rows (the `status = 'new'` guard on the
-- refresh update). This one-time pass clears the backlog of added/dismissed
-- rows that predate that change. `raw` is NOT NULL, so it is emptied to '{}'.

UPDATE public.discovery_candidates
SET raw = '{}'::jsonb,
    headline = NULL,
    location = NULL,
    photo_url = NULL,
    position = NULL
WHERE status IN ('added', 'dismissed')
  AND (
    raw <> '{}'::jsonb
    OR headline IS NOT NULL
    OR location IS NOT NULL
    OR photo_url IS NOT NULL
    OR position IS NOT NULL
  );

-- Plan 24 Phase 2b: one-time normalization of existing contacts.linkedin_url
-- rows to the canonical form the code now writes:
--   https://www.linkedin.com/in/<slug>
-- (slug lowercased, UNLESS it is an internal ACoAA/ACwAA member id, which
-- is case-sensitive). New writes canonicalize in code (linkedin-url.ts);
-- this brings pre-existing rows onto the same form so exact-string dedupe
-- works across trailing-slash / www / case / query-string variants.
--
-- Rows whose URL doesn't contain a linkedin.com/in/ profile path are left
-- untouched.

UPDATE contacts c
SET linkedin_url = 'https://www.linkedin.com/in/' ||
  CASE
    WHEN s.slug ~ '^AC[ow]AA' THEN s.slug
    ELSE lower(s.slug)
  END
FROM (
  SELECT id,
         regexp_replace(substring(linkedin_url from '(?i)linkedin\.com/in/([^/?#]+)'), '/+$', '') AS slug
  FROM contacts
  WHERE linkedin_url ~* 'linkedin\.com/in/'
) s
WHERE c.id = s.id
  AND s.slug IS NOT NULL
  AND s.slug <> ''
  AND c.linkedin_url IS DISTINCT FROM (
    'https://www.linkedin.com/in/' ||
    CASE WHEN s.slug ~ '^AC[ow]AA' THEN s.slug ELSE lower(s.slug) END
  );

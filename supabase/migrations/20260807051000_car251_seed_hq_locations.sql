-- CAR-251 step 2 of 3: give a location to the 27 targeted companies that the
-- tier backfill could not reach.
--
-- These carry the two NON-GEOGRAPHIC tier labels — `Big Tech` (23) and
-- `Other Hubs` (4) — so there was no metro to migrate. 24 of the 27 have ZERO
-- contacts, which is precisely why they were never located: `company_locations`
-- is built from scraped employee records, and nothing was ever scraped for them.
--
-- Every one is a well-known company with an unambiguous public headquarters, so
-- the alternative (leaving them under "No location set" forever) loses real
-- filterability for no benefit. `source = 'hq_seed'` marks them as PUBLIC HQ
-- DATA rather than anything observed in this account's network, so they stay
-- separable from scraped evidence and reversible.
--
-- Two guards make this safe even though it matches on company NAME:
--
--   1. Only companies that currently have NO office row at all are touched, so
--      the worst case of a name collision is adding an HQ to a company that had
--      no location — never overwriting or contradicting existing data.
--   2. Only companies that are someone's target WITH a tier are touched, which
--      scopes this to exactly the 27 rows it was written for.
--
-- Like the previous migration, it no-ops on a fresh CI database.
--
-- TWO ENTRIES ARE JUDGMENT CALLS, flagged for correction:
--   * 'Tinder / Match Group' — the label spans a product and its parent. Match
--     Group's corporate HQ is Dallas, TX; Tinder's product org sits in West
--     Hollywood, CA. Seeded as West Hollywood because the label leads with
--     Tinder and the product org is what a PM search cares about.
--   * 'Relativity' — shares a name with Relativity Space (Long Beach, CA).
--     Seeded as Chicago (the legal-software company), because it arrived under
--     'Other Hubs' beside Braze, Bumble and Justworks, which are all consumer
--     and B2B software in non-Bay-Area hubs.
-- Both are one edit to fix once office locations are editable in the UI.

CREATE TEMP TABLE car251_hq_seed (
  company_name text PRIMARY KEY,
  city         text NOT NULL,
  state        text NOT NULL
) ON COMMIT DROP;

INSERT INTO car251_hq_seed (company_name, city, state) VALUES
  -- Big Tech (23)
  ('Block / Square',         'Oakland',         'California'),
  ('CarMax',                 'Richmond',        'Virginia'),
  ('Cognex',                 'Natick',          'Massachusetts'),
  ('Databricks',             'San Francisco',   'California'),
  ('DoorDash',               'San Francisco',   'California'),
  ('Duolingo',               'Pittsburgh',      'Pennsylvania'),
  ('Experian',               'Costa Mesa',      'California'),      -- North America HQ; group HQ is Dublin
  ('Instacart',              'San Francisco',   'California'),
  ('Jane Street',            'New York',        'New York'),
  ('Kleiner Perkins',        'Menlo Park',      'California'),
  ('Lyft',                   'San Francisco',   'California'),
  ('Pinterest',              'San Francisco',   'California'),
  ('PNC Financial Services', 'Pittsburgh',      'Pennsylvania'),
  ('Robinhood',              'Menlo Park',      'California'),
  ('Roblox',                 'San Mateo',       'California'),
  ('Samsung',                'Ridgefield Park', 'New Jersey'),      -- Samsung Electronics America
  ('Schmidt Futures',        'New York',        'New York'),
  ('SeatGeek',               'New York',        'New York'),
  ('Spotify',                'New York',        'New York'),        -- US HQ; group HQ is Stockholm
  ('The New York Times',     'New York',        'New York'),
  ('Tinder / Match Group',   'West Hollywood',  'California'),      -- judgment call, see header
  ('Warner Bros. Discovery', 'New York',        'New York'),
  ('Warner Music Group',     'New York',        'New York'),
  -- Other Hubs (4)
  ('Braze',                  'New York',        'New York'),
  ('Bumble',                 'Austin',          'Texas'),
  ('Justworks',              'New York',        'New York'),
  ('Relativity',             'Chicago',         'Illinois');        -- judgment call, see header

-- Find-or-create each HQ city.
INSERT INTO locations (city, state, country)
SELECT s.city, s.state, 'United States'
FROM car251_hq_seed s
ON CONFLICT (city, state, country) DO NOTHING;

INSERT INTO company_locations (company_id, location_id, source)
SELECT DISTINCT c.id, l.id, 'hq_seed'
FROM car251_hq_seed s
JOIN companies c ON c.name = s.company_name
JOIN locations l
  ON l.city = s.city AND l.state = s.state AND l.country = 'United States'
WHERE NOT EXISTS (
        SELECT 1 FROM company_locations existing WHERE existing.company_id = c.id
      )
  AND EXISTS (
        SELECT 1 FROM target_companies tc
        WHERE tc.company_id = c.id AND tc.tier IS NOT NULL
      )
ON CONFLICT (company_id, location_id) DO NOTHING;

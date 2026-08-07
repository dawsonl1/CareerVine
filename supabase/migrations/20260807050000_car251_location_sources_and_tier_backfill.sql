-- CAR-251 step 1 of 3: preserve the geography encoded in target_companies.tier
-- as real office rows, BEFORE the tier column is dropped.
--
-- Why this migration exists at all: `tier` looks redundant with the location
-- model but is not. `company_locations` is populated almost entirely from
-- SCRAPED EMPLOYEE locations, and the reference account's network is
-- Utah-concentrated, so Utah-tiered companies got office rows for free while
-- out-of-state ones did not (San Diego: 0 of 17 had any location). For 117
-- companies the tier string is the ONLY record that the company is in Boston /
-- the Bay Area / LA. Dropping the column without this step destroys that.
--
-- Two properties this migration deliberately holds:
--
--   1. It ADDS, never replaces. A company whose recorded office contradicts its
--      tier (Toast is tiered Boston; its only office row is San Mateo, because
--      that is where the scraped contact sits) gains the tier's city ALONGSIDE
--      what it has. `company_locations` means "an office", not "the office" —
--      multi-office is what the join table is for. Companies that already have
--      a real office in the tier's state are skipped entirely, so specific
--      scraped cities (Lehi, Provo, Orem) are never overwritten with an anchor.
--
--   2. It no-ops on an empty database. CI runs `supabase start` against a fresh
--      DB where no tier rows exist, so every INSERT below selects zero rows.
--
-- The anchors are metro principal cities, chosen with the account owner. They
-- are ASSERTIONS at metro fidelity, not observations: "SF Bay Area" becomes San
-- Francisco even for a company actually in San Jose. That is exactly the
-- fidelity the tier itself carried, and `source = 'tier_migration'` is what
-- keeps these rows identifiable and reversible once the column is gone.
--
-- `Big Tech` (86 companies) and `Other Hubs` (14) are NOT in the mapping: they
-- are segment labels carrying no geography, so they migrate nothing. The 27
-- companies left with no location at all are handled by the next migration.

-- ═══════════════════════════════════════════════════════════
-- 1. Provenance: two new source values
-- ═══════════════════════════════════════════════════════════
-- 'tier_migration' — written here, derived from a tier label.
-- 'hq_seed'        — written by the next migration, public HQ data.
-- Both are distinguishable from 'scraped' (observed from an employee record)
-- and 'manual' (a user typed it), so a later audit can tell what is evidence
-- and what is assertion.
ALTER TABLE company_locations DROP CONSTRAINT IF EXISTS company_locations_source_check;
ALTER TABLE company_locations ADD CONSTRAINT company_locations_source_check
  CHECK (source IN ('scraped', 'manual', 'tier_migration', 'hq_seed'));

COMMENT ON COLUMN company_locations.source IS
  'How this office row came to exist: scraped (observed on an employee''s experience record), manual (entered by a user), tier_migration (CAR-251, derived from the retired target_companies.tier label at metro fidelity), hq_seed (CAR-251, public headquarters data).';

-- ═══════════════════════════════════════════════════════════
-- 2. The tier → anchor city mapping
-- ═══════════════════════════════════════════════════════════
CREATE TEMP TABLE car251_tier_anchor (
  tier  text PRIMARY KEY,
  city  text NOT NULL,
  state text NOT NULL
) ON COMMIT DROP;

INSERT INTO car251_tier_anchor (tier, city, state) VALUES
  ('Utah/Silicon Slopes', 'Lehi',          'Utah'),
  ('SF Bay Area',         'San Francisco', 'California'),
  ('Boston',              'Boston',        'Massachusetts'),
  ('Los Angeles',         'Los Angeles',   'California'),
  ('San Diego',           'San Diego',     'California'),
  ('Seattle',             'Seattle',       'Washington'),
  ('Other Hubs (NYC)',    'New York',      'New York');

-- ═══════════════════════════════════════════════════════════
-- 3. Find-or-create each anchor location
-- ═══════════════════════════════════════════════════════════
-- locations carries UNIQUE (city, state, country), so ON CONFLICT DO NOTHING
-- makes this idempotent and reuses the existing row wherever the scraper has
-- already created one (it has, for most of these).
INSERT INTO locations (city, state, country)
SELECT a.city, a.state, 'United States'
FROM car251_tier_anchor a
ON CONFLICT (city, state, country) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- 4. Attach the anchor to every tiered company that needs one
-- ═══════════════════════════════════════════════════════════
-- "Needs one" = the company has NO existing office row anywhere in the tier's
-- state. State-level rather than city-level on purpose: a Utah-tiered company
-- already recorded in Provo does not need a synthetic Lehi row, because a Utah
-- filter finds it either way and Provo is the better datum.
--
-- DISTINCT because target_companies holds one row per company AND per targeted
-- office scope, so a company with two targeted offices appears more than once.
INSERT INTO company_locations (company_id, location_id, source)
SELECT DISTINCT tc.company_id, l.id, 'tier_migration'
FROM target_companies tc
JOIN car251_tier_anchor a ON a.tier = tc.tier
JOIN locations l
  ON l.city = a.city AND l.state = a.state AND l.country = 'United States'
WHERE tc.tier IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM company_locations existing
    JOIN locations el ON el.id = existing.location_id
    WHERE existing.company_id = tc.company_id
      AND el.state = a.state
  )
ON CONFLICT (company_id, location_id) DO NOTHING;

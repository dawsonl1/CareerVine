-- CAR-155: one-off cleanup merging duplicate locations rows that pre-CAR-155
-- writers created by skipping normalization. Pairs verified against
-- production on 2026-07-19 by grouping every locations row under the
-- app-side normalizer (normalizeParsedLocation):
--
--   src  → dst   (dst is the row matching the normalizer's canonical output,
--                 so post-CAR-155 probes land on the survivor)
--   13   → 11    Seattle, WA           → Seattle, Washington
--   28   → 12    New York, NY          → New York, New York
--   25   → 174   Cambridge, MA         → Boston, Massachusetts (metro alias)
--   60   → 105   District Of Columbia  → District of Columbia (lookupState fix)
--   1523 → 322   SLC, Utah             → Slc, Utah
--   1522 → 410   McLean, Virginia      → Mclean, Virginia
--
-- Repoints every FK (contacts, contact_companies, company_locations,
-- target_companies, target_company_notes), deduping company_locations where
-- the (company_id, dst) pair already exists, then deletes the source rows.
-- Idempotent: a re-run finds no source rows and no-ops.

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
UPDATE contacts c SET location_id = p.dst
FROM pairs p WHERE c.location_id = p.src;

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
UPDATE contact_companies cc SET location_id = p.dst
FROM pairs p WHERE cc.location_id = p.src;

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
UPDATE target_companies tc SET location_id = p.dst
FROM pairs p WHERE tc.location_id = p.src;

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
UPDATE target_company_notes tn SET location_id = p.dst
FROM pairs p WHERE tn.location_id = p.src;

-- company_locations carries UNIQUE (company_id, location_id): drop source
-- rows whose company already has the destination row, then repoint the rest.
WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
DELETE FROM company_locations cl
USING pairs p
WHERE cl.location_id = p.src
  AND EXISTS (
    SELECT 1 FROM company_locations x
    WHERE x.company_id = cl.company_id AND x.location_id = p.dst
  );

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
UPDATE company_locations cl SET location_id = p.dst
FROM pairs p WHERE cl.location_id = p.src;

WITH pairs(src, dst) AS (
  VALUES (13, 11), (28, 12), (25, 174), (60, 105), (1523, 322), (1522, 410)
)
DELETE FROM locations l
USING pairs p WHERE l.id = p.src;

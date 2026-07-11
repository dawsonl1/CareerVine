-- CAR-62: publish-time bundle snapshot resolution.
-- Companies/locations/schools are resolved ONCE when a bundle version is
-- published (bundle-resolve.ts) and stored per prospect, so subscriber syncs
-- stop re-resolving the same global entities per user per chunk, and blank
-- subscribers (onboarding) can bulk-apply the whole bundle in seconds.

ALTER TABLE bundle_prospects
  ADD COLUMN IF NOT EXISTS resolved jsonb,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

COMMENT ON COLUMN bundle_prospects.resolved IS
  'Publish-time entity resolution snapshot (CAR-62): { payload_hash, profile_location_id, experiences: [{company_id, location_id, location_source}], education: [{school_id}] }, positionally aligned with payload.experiences/payload.education. payload_hash mismatch = stale (re-resolved on next publish); readers then fall back to live resolution.';
COMMENT ON COLUMN bundle_prospects.resolved_at IS
  'When the resolution snapshot was last written.';

ALTER TABLE data_bundles
  ADD COLUMN IF NOT EXISTS resolved_version int NOT NULL DEFAULT 0;

COMMENT ON COLUMN data_bundles.resolved_version IS
  'Committed version whose live prospects ALL carry a hash-current resolution snapshot. resolved_version = version gates the fast-apply path (CAR-62); anything else takes the merge path.';

-- One-round-trip resolution writer for the resolver''s chunk loop: updates a
-- batch of prospect rows from a jsonb array of {id, resolved} pairs. Service
-- path only — bundle content tables deliberately have no user write policies,
-- and this function must not become one.
CREATE OR REPLACE FUNCTION apply_bundle_resolutions(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count int;
BEGIN
  UPDATE bundle_prospects bp
  SET resolved = r.resolved,
      resolved_at = now(),
      updated_at = now()
  FROM jsonb_to_recordset(p_rows) AS r(id int, resolved jsonb)
  WHERE bp.id = r.id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION apply_bundle_resolutions(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_bundle_resolutions(jsonb) TO service_role;

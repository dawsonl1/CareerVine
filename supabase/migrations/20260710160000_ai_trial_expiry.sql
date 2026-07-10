-- CAR-51: 24-hour shared-AI trial.
--
-- Entitlements gain an expiry: NULL expires_at = permanent grant (every
-- pre-existing admin grant keeps working untouched); a trial row carries
-- expires_at = first_use + 24h and granted_by = 'trial'. The gate predicate
-- becomes shared_access AND (expires_at IS NULL OR expires_at > now()).
--
-- access_requested_at records the user pressing "Request AI access" after
-- expiry — used to dedupe the notification to the owner and as an
-- engaged-user signal. It survives grants/revocations as an audit breadcrumb.

ALTER TABLE user_ai_access
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN access_requested_at timestamptz;

COMMENT ON COLUMN user_ai_access.expires_at IS
  'Entitlement expiry. NULL = permanent (admin grant); trial rows get first AI use + 24h.';
COMMENT ON COLUMN user_ai_access.access_requested_at IS
  'When the user last requested continued shared-AI access after trial expiry (CAR-51).';

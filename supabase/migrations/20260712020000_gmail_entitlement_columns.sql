-- CAR-103: Tier capability layer — entitlement flag columns on gmail_connections.
--
-- These two flags are the inputs to the capability resolver (resolveCapabilities).
-- They are service-role-only by default: both fall OUTSIDE CAR-27's authenticated
-- column-grant (20260710100000_lock_down_gmail_connection_tokens.sql granted SELECT
-- on an explicit 5-column list), so the browser client cannot read them without an
-- explicit GRANT amendment. No GRANT change is needed or wanted here.
--
-- Phase 0 (CAR-103) intentionally keeps modify_scope_granted DEFAULT true: the app
-- still requests gmail.modify on every connect, so existing rows and any new
-- connection made in the CAR-103 -> CAR-102 window genuinely hold modify. CAR-102
-- flips this default to false in the SAME change that (a) drops gmail.modify from
-- the default consent flow and (b) teaches the OAuth callback to persist
-- modify_scope_granted from the actually-granted scopes (mirroring how
-- calendar_scopes_granted is set). Do NOT flip the default here.

ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS automatic_features_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS modify_scope_granted boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.gmail_connections.automatic_features_enabled IS
  'CAR-103: admin-granted entitlement to the paid automatic features (auto reply-detection + bounce-cancel). Default false; set via the admin automatic-features toggle.';

COMMENT ON COLUMN public.gmail_connections.modify_scope_granted IS
  'CAR-103: whether this connection holds the gmail.modify scope. Default true in Phase 0 (every connect still requests it); CAR-102 flips the default to false and persists the real granted value in the OAuth callback.';

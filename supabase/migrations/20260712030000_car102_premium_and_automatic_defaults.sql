-- CAR-102 Phase A: premium entitlement flag + automatic-features default flip.
--
-- premium_enabled is the admin-controlled master switch for the premium (Inbox)
-- experience, kept DISTINCT from modify_scope_granted (a truthful fact: does the
-- token physically hold gmail.modify, set by the OAuth callback). Premium is the
-- conjunction: modify_scope_granted AND premium_enabled. An admin flips a user to
-- the free Outreach tier by turning premium_enabled off -- no reconnect required,
-- and without corrupting the token-fact column. Default true so existing premium
-- users stay premium; new free connects are gated by modify_scope_granted=false
-- regardless, so the true default grants a free user nothing.
--
-- automatic_features_enabled flips to DEFAULT true (was false in CAR-103): premium
-- accounts get automatic follow-ups out of the box, and the admin toggle becomes an
-- opt-out. The backfill sets existing rows true so current premium users keep
-- auto-sending follow-ups seamlessly across the CAR-102 deploy (the send-follow-ups
-- cron begins gating on this flag in the same release). Safe for free users:
-- followups:auto still requires isPremium, so a modify-less user gains nothing.
-- Backfill is unconditional because no deliberate opt-out exists at build time (the
-- cron never consulted the flag before CAR-102, so no stored false is meaningful).
--
-- Service-role-only: both columns fall outside CAR-27's authenticated column-grant
-- (20260710100000_lock_down_gmail_connection_tokens.sql). No GRANT change needed.

ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS premium_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.gmail_connections
  ALTER COLUMN automatic_features_enabled SET DEFAULT true;

UPDATE public.gmail_connections
  SET automatic_features_enabled = true
  WHERE automatic_features_enabled = false;

COMMENT ON COLUMN public.gmail_connections.premium_enabled IS
  'CAR-102: admin master switch for the premium (Inbox) experience. Premium = modify_scope_granted AND premium_enabled. Default true; turn off to move a user to the free Outreach tier with no reconnect (modify_scope_granted stays a truthful token-fact).';

COMMENT ON COLUMN public.gmail_connections.automatic_features_enabled IS
  'CAR-102: automatic follow-ups (auto reply-detection + auto-send). Default true (was false in CAR-103); the admin toggle is now an opt-out. Gated by followups:auto = automatic_features_enabled AND isPremium, so a free user gains nothing from a true value.';

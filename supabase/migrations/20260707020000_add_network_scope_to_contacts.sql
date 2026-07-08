-- Plan 24 addendum: contacts.network_scope (pipeline README §6.3/§7).
--
-- The pipeline's Search A finds BYU-family product alumni nationwide, not
-- just at target companies. Its selection gate labels each person:
--   target_company — works at one of the ~105 target companies
--   broad_network  — a real BYU-family product-role alum at some OTHER
--                    company, kept as a general networking/referral contact
-- Searches B and C are company-scoped by construction, so their records
-- are always target_company. NULL = not from the pipeline (manual/extension
-- contacts have no scope).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS network_scope text
  CHECK (network_scope IN ('target_company', 'broad_network'));

COMMENT ON COLUMN contacts.network_scope IS 'Pipeline segment: target_company = works at a target company; broad_network = BYU-family product alum elsewhere, kept for general networking; NULL = not a pipeline import';

-- Remove the new-account walkthrough (onboarding) feature.
-- The guided intro was buggy and outdated; all app code for it is deleted.
--
-- Kept: email_messages.is_simulated. It was added by the onboarding
-- migration for fake welcome replies, but plan-24 features now depend on
-- it (stage derivation, daily send cap, company traction queries) and
-- existing simulated rows must keep rendering without Gmail API calls.

DROP TABLE IF EXISTS user_onboarding;

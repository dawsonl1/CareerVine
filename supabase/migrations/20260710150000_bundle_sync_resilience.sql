-- Bundle sync/unsubscribe resilience (CAR-47 audit follow-ups CAR-53/CAR-54).
--
-- Two gaps made interrupted drivers lossy:
--  1. A sync interrupted mid-loop (platform kill, budget expiry, dead
--     browser) restarted from chunk 0 — synced_version only advances on
--     full completion, so background retries re-scanned everything.
--  2. An unsubscribe loop that died mid-removal stranded its remaining
--     bundle_subscription_contacts rows forever: the status flip fences
--     out every sync driver, and nothing recorded the keepAll intent
--     needed to resume the cleanup.

ALTER TABLE bundle_subscriptions
  ADD COLUMN IF NOT EXISTS sync_cursor jsonb,
  ADD COLUMN IF NOT EXISTS unsubscribe_keep_all boolean;

COMMENT ON COLUMN bundle_subscriptions.sync_cursor IS
  'Mid-sync checkpoint {phase, afterId, pinnedVersion}, written after each applied chunk and cleared when the sync commits (or on resubscribe reset). Lets the worker/cron resume an interrupted sync instead of re-scanning from chunk 0.';
COMMENT ON COLUMN bundle_subscriptions.unsubscribe_keep_all IS
  'Pending unsubscribe cleanup intent (true = keep all contacts / drop linkage, false = remove untouched bundle-created contacts). Set when an unsubscribe starts, cleared when its removal loop completes; non-null on an unsubscribed row means cleanup is unfinished and the worker/cron may resume it.';

-- Cron sweep for unfinished unsubscribe cleanups.
CREATE INDEX IF NOT EXISTS bundle_subscriptions_pending_unsub_idx
  ON bundle_subscriptions (id)
  WHERE status = 'unsubscribed' AND unsubscribe_keep_all IS NOT NULL;

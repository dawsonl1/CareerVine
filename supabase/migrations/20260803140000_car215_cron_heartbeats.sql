-- CAR-215: liveness record for the A1 send watcher.
--
-- The watcher is now the thing that makes email go out on time; QStash is the
-- hourly safety net behind it. If the watcher dies quietly, delivery silently
-- degrades from seconds to an hour and nobody finds out until a user notices.
-- Free-tier Oracle boxes do get reclaimed, and the ampere-poller precedent
-- shows they fail without saying anything.
--
-- So the two callers of the send routes leave different traces:
--   - the watcher (bearer auth) stamps last_seen_at on every sweep it triggers,
--   - QStash (signature auth) reads that stamp and, if it has gone stale,
--     emails the owner.
--
-- The safety net checking on the watcher is the point: whichever one dies, the
-- other is still running and can report it. A BetterStack heartbeat covers the
-- remaining case where the whole app is unreachable.

CREATE TABLE IF NOT EXISTS cron_heartbeats (
  name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  -- When we last emailed about this being stale. Without it, an hourly safety
  -- net would send an hourly email for as long as the box stays down.
  last_alerted_at timestamptz
);

COMMENT ON TABLE cron_heartbeats IS
  'CAR-215: last-seen stamps for out-of-band job drivers. Currently just the A1 send watcher, which stamps on every sweep it triggers so the QStash safety net can notice it has gone quiet.';

ALTER TABLE cron_heartbeats ENABLE ROW LEVEL SECURITY;

-- Service role only. No end user has any business reading or writing this, and
-- the watcher role deliberately gets nothing: it reports liveness by calling
-- the app, not by writing to the database.
CREATE POLICY "Service role full access to cron_heartbeats"
  ON cron_heartbeats FOR ALL USING (auth.role() = 'service_role');

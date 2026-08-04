/**
 * Liveness stamps for the out-of-band send drivers (CAR-215).
 *
 * Delivery is now driven by the A1 send watcher, which pokes the send routes
 * within ~15s of anything coming due. QStash still runs the same routes hourly
 * as a safety net. That pairing is what makes a dead watcher survivable: mail
 * still goes out, just an hour late.
 *
 * The danger is that the degradation is INVISIBLE. Everything keeps working, a
 * bit worse, indefinitely. Free-tier Oracle instances are reclaimed without
 * recourse, and the ampere-poller precedent shows these boxes fail quietly (it
 * provisioned a VM and logged nothing about it).
 *
 * What is implemented, stated exactly (CAR-220 rewrote a claim here that the
 * two drivers watch each other, which they did not):
 *
 *   - watcher -> stamped and READ. The watcher stamps `cron_heartbeats` on
 *     every sweep it triggers; the QStash path reads that stamp and emails when
 *     it has gone stale. A dead watcher is reported.
 *   - QStash -> stamped, NOT read. Nothing consumes the `qstash` row yet, so a
 *     paused or deleted QStash schedule is currently invisible — and it silently
 *     takes the watcher alarm with it, because the staleness check below only
 *     runs on a QStash tick. Closing that half needs a reader outside this app;
 *     the watcher is the natural home, since it already holds a Postgres
 *     connection and could refuse its own BetterStack beat when the `qstash`
 *     stamp is older than a couple of hours.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyOwner } from "@/lib/admin-notify";

/** Row key for the A1 send watcher. */
export const SEND_WATCHER = "send-watcher";

/**
 * Row key for the hourly QStash safety net.
 *
 * Stamped by the cron routes, read by nothing yet — see the module docstring
 * for what would have to exist for this row to raise an alarm. The table's
 * `name` primary key was always meant to hold more than one driver.
 */
export const QSTASH_SAFETY_NET = "qstash";

/**
 * How quiet the watcher must go before we call it dead.
 *
 * It sweeps at least every FLOOR_SECONDS (900s, ops/send-watcher/README.md)
 * even with nothing due, so a healthy watcher always stamps well inside this.
 * 40 minutes tolerates a missed floor sweep plus a restart without crying wolf.
 *
 * It does NOT set how fast a dead watcher is noticed. The check runs only on a
 * QStash tick, and QStash runs hourly, so the alert lands at the first hourly
 * tick that is at least this far past the last stamp: 40 to 100 minutes after
 * the watcher went quiet. Lowering this number moves the floor of that window,
 * never its cadence — only a faster safety-net schedule does that.
 */
export const WATCHER_STALE_MINUTES = 40;

/** Do not re-alert more often than this while the watcher stays down. */
export const WATCHER_ALERT_COOLDOWN_HOURS = 12;

/**
 * Record that `name` just drove a sweep.
 *
 * Never throws: a bookkeeping failure must not fail a send. That is not the
 * same as harmless, so every failure is logged. A beat that never lands leaves
 * no row (or a frozen one), and `checkWatcherHealth` reads a missing row as
 * "not provisioned yet" — so a persistently failing upsert DISARMS the alarm
 * rather than firing a false one. The log below is the only signal that
 * happens.
 *
 * Both failure shapes are handled because they are different failures:
 * supabase-js returns a PostgREST refusal in `{ error }` without throwing
 * (`shouldThrowOnError` defaults false), so the catch alone would only ever see
 * a transport error and a real DB refusal would pass silently (CAR-220).
 */
export async function recordDriverBeat(
  service: SupabaseClient,
  name: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  try {
    const { error } = await service
      .from("cron_heartbeats")
      .upsert({ name, last_seen_at: nowIso }, { onConflict: "name" });
    if (error) {
      console.error(`[watcher-health] beat upsert for '${name}' refused:`, error.message);
    }
  } catch (err) {
    console.error(`[watcher-health] failed to record beat for '${name}':`, err);
  }
}

/** Record that the A1 send watcher just drove a sweep. */
export async function recordWatcherBeat(
  service: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  return recordDriverBeat(service, SEND_WATCHER, nowIso);
}

interface HeartbeatRow {
  last_seen_at: string;
  last_alerted_at: string | null;
}

export interface WatcherHealth {
  stale: boolean;
  lastSeenAt: string | null;
  quietMinutes: number | null;
  alerted: boolean;
}

/**
 * Called on the QStash (safety-net) path. Emails the owner the first time the
 * watcher goes quiet, then at most once per cooldown while it stays quiet.
 *
 * A MISSING row is an anomaly, not a startup state. It was the latter until
 * CAR-220's migration seeded `send-watcher` at now(); afterwards, no row means
 * the migration has not run against this database or something deleted it.
 * That matters because this row is the alarm's only anchor: without it the
 * staleness comparison has nothing to measure, so the alarm can never arm no
 * matter how long the watcher stays dead. So a missing row is logged and
 * re-anchored (one write, the same anchor-not-observation compromise the
 * migration's seed makes) rather than accepted as healthy.
 *
 * It is still not ALERTED on, and that is not timidity: a missing row is
 * evidence about the row, not about the watcher, and "the watcher has gone
 * quiet" is a claim this function would have no basis for. Re-anchoring puts a
 * real alert back within one staleness window if the watcher really is gone.
 */
export async function checkWatcherHealth(
  service: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<WatcherHealth> {
  const nowMs = new Date(nowIso).getTime();
  const idle: WatcherHealth = { stale: false, lastSeenAt: null, quietMinutes: null, alerted: false };

  let row: HeartbeatRow | null = null;
  try {
    // A failed staleness read is treated as "cannot tell", which suppresses the
    // alert rather than firing a false one, and the next safety-net run
    // re-checks an hour later. Nothing else covers a read that stays broken:
    // the watcher's BetterStack heartbeat fires on its own Postgres read and
    // never touches this path, so a persistently failing read means no alarm at
    // all. Hence the log — and hence checking the RETURNED error, not just the
    // thrown one: `{ data: null, error }` is otherwise indistinguishable from
    // "no row yet", which is a healthy verdict (CAR-220).
    const { data, error } = await service
      .from("cron_heartbeats")
      .select("last_seen_at, last_alerted_at")
      .eq("name", SEND_WATCHER)
      .maybeSingle();
    if (error) {
      console.error("[watcher-health] staleness read refused:", error.message);
      return idle;
    }
    row = (data as HeartbeatRow | null) ?? null;
  } catch (err) {
    console.error("[watcher-health] staleness read failed:", err);
    return idle;
  }
  if (!row) {
    console.error(
      `[watcher-health] '${SEND_WATCHER}' heartbeat row is missing — the staleness alarm has no anchor and cannot arm; re-anchoring at ${nowIso}. Check that the seeding migration ran.`,
    );
    await recordDriverBeat(service, SEND_WATCHER, nowIso);
    return idle;
  }

  const quietMs = nowMs - new Date(row.last_seen_at).getTime();
  const quietMinutes = Math.floor(quietMs / 60_000);
  if (quietMinutes < WATCHER_STALE_MINUTES) {
    return { stale: false, lastSeenAt: row.last_seen_at, quietMinutes, alerted: false };
  }

  const cooledDown =
    !row.last_alerted_at ||
    nowMs - new Date(row.last_alerted_at).getTime() >= WATCHER_ALERT_COOLDOWN_HOURS * 3_600_000;

  let alerted = false;
  if (cooledDown) {
    const hours = (quietMinutes / 60).toFixed(1);
    alerted = await notifyOwner(
      "CareerVine: the A1 send watcher has gone quiet",
      [
        `The send watcher on the Oracle A1 box has not triggered a sweep in ${hours} hours.`,
        `Last seen: ${row.last_seen_at}`,
        "",
        "Email is still going out, but on the hourly QStash safety net instead of",
        "within seconds of the scheduled time. Nothing is lost or stuck.",
        "",
        "To check:",
        "  ssh a1 'systemctl status careervine-send-watcher'",
        "  ssh a1 'journalctl -u careervine-send-watcher -n 50 --no-pager'",
        "",
        "If the box itself is gone, ops/send-watcher/README.md has the rebuild steps.",
        `You will not get this again for ${WATCHER_ALERT_COOLDOWN_HOURS} hours.`,
      ].join("\n"),
    );
    if (alerted) {
      // Losing this stamp means a repeat email every hour until the box comes
      // back, not a missed alert. Both failure shapes are checked for the same
      // reason as the beat upsert: a PostgREST refusal is returned, not thrown.
      try {
        const { error } = await service
          .from("cron_heartbeats")
          .update({ last_alerted_at: nowIso })
          .eq("name", SEND_WATCHER);
        if (error) {
          console.error("[watcher-health] alert stamp refused:", error.message);
        }
      } catch (err) {
        console.error("[watcher-health] failed to record alert stamp:", err);
      }
    }
  }

  return { stale: true, lastSeenAt: row.last_seen_at, quietMinutes, alerted };
}

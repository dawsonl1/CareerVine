/**
 * Mutual liveness checking between the two send drivers (CAR-215).
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
 * So the two drivers watch each other: the watcher stamps `cron_heartbeats` on
 * every sweep it triggers, and QStash reads that stamp and emails when it goes
 * stale. Whichever driver dies, the survivor reports it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyOwner } from "@/lib/admin-notify";

/** Row key for the A1 send watcher. */
export const SEND_WATCHER = "send-watcher";

/**
 * How quiet the watcher must go before we call it dead.
 *
 * It sweeps at least every FLOOR_SECONDS (15 min) even with nothing due, so a
 * healthy watcher always stamps well inside this. 40 minutes tolerates a missed
 * floor sweep plus a restart without crying wolf, while still beating the
 * hourly safety net to the punch.
 */
export const WATCHER_STALE_MINUTES = 40;

/** Do not re-alert more often than this while the watcher stays down. */
export const WATCHER_ALERT_COOLDOWN_HOURS = 12;

/**
 * Record that the watcher just drove a sweep.
 *
 * Best-effort: a failure here must never turn into a failed send. The worst
 * case is a false staleness alert, which is the safe direction to be wrong in.
 */
export async function recordWatcherBeat(
  service: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  try {
    await service
      .from("cron_heartbeats")
      .upsert({ name: SEND_WATCHER, last_seen_at: nowIso }, { onConflict: "name" });
  } catch (err) {
    console.error("[watcher-health] failed to record beat:", err);
  }
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
 * Deliberately does NOT alert when there is no row at all: that is the state
 * before the watcher has ever run, i.e. between this shipping and the box being
 * provisioned, and alerting there would just be noise on day one.
 */
export async function checkWatcherHealth(
  service: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<WatcherHealth> {
  const nowMs = new Date(nowIso).getTime();
  const idle: WatcherHealth = { stale: false, lastSeenAt: null, quietMinutes: null, alerted: false };

  let row: HeartbeatRow | null = null;
  try {
    // error-tolerated: a failed staleness read is treated as "cannot tell",
    // which suppresses the alert rather than firing a false one. The next
    // safety-net run re-checks an hour later, and the BetterStack heartbeat
    // covers the case where this path is broken for longer than that.
    const { data } = await service
      .from("cron_heartbeats")
      .select("last_seen_at, last_alerted_at")
      .eq("name", SEND_WATCHER)
      .maybeSingle();
    row = (data as HeartbeatRow | null) ?? null;
  } catch (err) {
    console.error("[watcher-health] staleness read failed:", err);
    return idle;
  }
  if (!row) return idle;

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
      try {
        await service
          .from("cron_heartbeats")
          .update({ last_alerted_at: nowIso })
          .eq("name", SEND_WATCHER);
      } catch (err) {
        // Losing this stamp means a repeat email next hour, not a missed alert.
        console.error("[watcher-health] failed to record alert stamp:", err);
      }
    }
  }

  return { stale: true, lastSeenAt: row.last_seen_at, quietMinutes, alerted };
}

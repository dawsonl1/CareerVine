#!/usr/bin/env python3
"""
CareerVine send watcher (CAR-215).

Runs on the Oracle A1 box. Its entire job is to notice, within seconds, that a
scheduled email or follow-up step has come due, and to poke the CareerVine cron
routes so the app sends it. It is a CLOCK, NOT A SCHEDULER: it never decides
what to send, never reads message contents, and holds no credential that could
let it.

── Why this exists ─────────────────────────────────────────────────────────

Delivery used to be driven purely by QStash cron at */15 (scheduled) and */10
(follow-ups). QStash itself is punctual (measured: fires within ~0.5s of the
tick), so all observed lateness was the polling interval: up to 15 minutes, and
systematically ~10 for the app's own 9:05 AM default, which lands just after a
:00/:15/:30/:45 tick.

── Why it watches Postgres instead of just calling the cron route ──────────

Having the box curl the cron endpoint every minute would be ~2,880 Vercel
invocations/day. Fluid bills active CPU against a 4 Active-CPU-hr/month Hobby
budget that bundle-sync and calendar polling already dominate (CAR-106), so
that trades a QStash quota for a Vercel one. Asking Postgres instead means the
overwhelming majority of ticks (nothing due) cost Vercel nothing, and triggers
drop to roughly one per batch of real email: fewer than the 96/day of empty
polls this replaces.

── What it can see ─────────────────────────────────────────────────────────

Exactly one thing: `SELECT * FROM due_send_counts()`, a SECURITY DEFINER
function returning two integers. The `careervine_watcher` role has EXECUTE on
that function and no table privileges whatsoever. Someone who takes this box
gets two numbers and the ability to make CareerVine run a sweep it was already
going to run.

── How it fails ────────────────────────────────────────────────────────────

Loudly and safely. QStash still runs both routes hourly as a safety net, so a
dead watcher degrades delivery to hourly rather than stopping it. A BetterStack
heartbeat is pinged after every successful cycle; when the pings stop,
BetterStack emails. A dead box cannot report its own death, which is why the
alerting lives off-box.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import psycopg2

LOG = logging.getLogger("send-watcher")

# ── Configuration (systemd EnvironmentFile) ─────────────────────────────────

@dataclass(frozen=True)
class Config:
    db_dsn: str
    app_base_url: str
    cron_secret: str
    poll_seconds: float
    heartbeat_url: str | None
    # Even with nothing due, poke each route this often so a row the counts
    # cannot see (a status vocabulary change, a bug in due_send_counts) still
    # gets processed without waiting for the hourly QStash safety net.
    floor_seconds: float
    # Backoff bounds for a backlog that will not drain. See `_note_result`.
    stuck_min_seconds: float
    stuck_max_seconds: float

    @staticmethod
    def from_env() -> "Config":
        missing = [
            k for k in ("WATCHER_DB_DSN", "APP_BASE_URL", "CRON_TRIGGER_SECRET")
            if not os.environ.get(k)
        ]
        if missing:
            raise SystemExit(f"missing required env: {', '.join(missing)}")
        return Config(
            db_dsn=os.environ["WATCHER_DB_DSN"],
            # Must be the www host: the apex 307-redirects and undici strips the
            # Authorization header on the cross-origin hop (learned rule 29).
            app_base_url=os.environ["APP_BASE_URL"].rstrip("/"),
            cron_secret=os.environ["CRON_TRIGGER_SECRET"],
            poll_seconds=float(os.environ.get("POLL_SECONDS", "15")),
            heartbeat_url=os.environ.get("HEARTBEAT_URL") or None,
            floor_seconds=float(os.environ.get("FLOOR_SECONDS", "900")),
            stuck_min_seconds=float(os.environ.get("STUCK_MIN_SECONDS", "60")),
            stuck_max_seconds=float(os.environ.get("STUCK_MAX_SECONDS", "900")),
        )


ROUTES = {
    "scheduled": "/api/cron/send-scheduled-emails",
    "follow_ups": "/api/cron/send-follow-ups",
}

# ── Graceful shutdown ───────────────────────────────────────────────────────

class Stopper:
    """Lets systemd stop us between cycles instead of mid-HTTP."""

    def __init__(self) -> None:
        self.stopped = False
        signal.signal(signal.SIGTERM, self._handle)
        signal.signal(signal.SIGINT, self._handle)

    def _handle(self, *_: object) -> None:
        LOG.info("shutdown signal received; finishing current cycle")
        self.stopped = True

    def wait(self, seconds: float) -> None:
        """Sleep in slices so a SIGTERM does not wait out a whole interval."""
        deadline = time.monotonic() + seconds
        while not self.stopped and time.monotonic() < deadline:
            time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))


# ── Work ────────────────────────────────────────────────────────────────────

def read_due_counts(conn) -> tuple[int, int]:
    """(scheduled_due, follow_ups_due). The only query this process ever makes."""
    with conn.cursor() as cur:
        cur.execute("SELECT scheduled_due, follow_ups_due FROM public.due_send_counts()")
        row = cur.fetchone()
    # Transaction-mode pooling: leaving a transaction open holds a server slot.
    conn.commit()
    return (int(row[0]), int(row[1])) if row else (0, 0)


def trigger(cfg: Config, route_key: str) -> bool:
    """POST a cron route with the shared bearer. True when it ran."""
    url = f"{cfg.app_base_url}{ROUTES[route_key]}"
    req = urllib.request.Request(
        url,
        data=b"{}",
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg.cron_secret}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            body = res.read(2000).decode("utf-8", "replace")
            LOG.info("triggered %s -> %s %s", route_key, res.status, body[:300])
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        detail = err.read(500).decode("utf-8", "replace")
        # 401 means the bearer is wrong or the app has not deployed it yet.
        # Loud, because the safety net is now the only thing delivering mail.
        LOG.error("trigger %s failed: HTTP %s %s", route_key, err.code, detail)
    except Exception as err:  # noqa: BLE001 - never let one bad cycle kill the loop
        LOG.error("trigger %s failed: %s: %s", route_key, type(err).__name__, err)
    return False


def beat(cfg: Config) -> None:
    """Tell BetterStack we are alive. Never fatal: alerting must not cause outages."""
    if not cfg.heartbeat_url:
        return
    try:
        with urllib.request.urlopen(cfg.heartbeat_url, timeout=10):
            pass
    except Exception as err:  # noqa: BLE001
        LOG.warning("heartbeat failed: %s: %s", type(err).__name__, err)


def connect(cfg: Config):
    conn = psycopg2.connect(cfg.db_dsn, connect_timeout=10)
    conn.autocommit = False
    return conn


class RouteState:
    """
    Per-route trigger pacing.

    ── The runaway this prevents ───────────────────────────────────────────

    "Due" does not mean "sendable". A user who has hit the 100/day cap leaves
    rows pending until tomorrow; `processScheduledEmails` breaks the batch on a
    429 by design. A bounced address is left pending until the NDR lands. In
    those states `due_send_counts()` keeps returning a positive number that no
    sweep can reduce, and a naive watcher would POST Vercel every 15 seconds for
    hours: thousands of invocations, far worse than the polling this replaces.

    So the trigger interval is driven by whether sweeps are making PROGRESS, not
    by whether work exists. A backlog that shrinks keeps fast, second-level
    delivery. A backlog that will not move backs off 60s -> 120s -> ... -> 15
    min, which is no worse than the old cron, and snaps back to immediate the
    moment the count drops or new work arrives.
    """

    def __init__(self) -> None:
        self.cooldown = 0.0
        self.next_ok = 0.0
        # The count as it stood when we last POSTed. Comparing against the last
        # TRIGGER rather than the last POLL is the whole trick: escalating per
        # poll would double the backoff four times inside a single 60s cooldown
        # at a 15s poll rate, so any momentary stall would slam straight to the
        # 15-minute cap and stay there.
        self.count_at_last_trigger: int | None = None

    def _reset(self) -> None:
        self.cooldown = 0.0
        self.next_ok = 0.0
        self.count_at_last_trigger = None

    def should_trigger(
        self, count: int, now: float, cfg: Config, last_trigger: float
    ) -> tuple[bool, str]:
        if count == 0:
            self._reset()
            if now - last_trigger >= cfg.floor_seconds:
                return True, "floor"
            return False, ""

        # Any movement at all, up or down, means something is happening: the
        # sweep drained rows, or new mail came due. Either way serve it promptly
        # and drop whatever penalty we had accrued. Only a count that is
        # EXACTLY unchanged since our last POST is evidence of a backlog no
        # sweep can shift, and that is the only thing that earns a backoff.
        if self.count_at_last_trigger is not None and count != self.count_at_last_trigger:
            self._reset()

        if now < self.next_ok:
            return False, ""
        stuck = count == self.count_at_last_trigger
        return True, "stuck" if stuck else "due"

    def note_triggered(self, count: int, now: float, cfg: Config, stuck: bool) -> None:
        if stuck:
            self.cooldown = min(
                max(self.cooldown * 2, cfg.stuck_min_seconds),
                cfg.stuck_max_seconds,
            )
        self.count_at_last_trigger = count
        self.next_ok = now + self.cooldown


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    cfg = Config.from_env()
    stopper = Stopper()
    LOG.info(
        "send-watcher up: poll=%ss floor=%ss target=%s",
        cfg.poll_seconds, cfg.floor_seconds, cfg.app_base_url,
    )

    conn = None
    last_trigger = {key: 0.0 for key in ROUTES}
    states = {key: RouteState() for key in ROUTES}
    # Exponential backoff on DB trouble so a Supabase blip does not become a
    # reconnect storm. Reset to the base interval on the first good read.
    backoff = cfg.poll_seconds

    while not stopper.stopped:
        cycle_ok = False
        try:
            if conn is None or conn.closed:
                conn = connect(cfg)
                LOG.info("database connection established")
            scheduled_due, follow_ups_due = read_due_counts(conn)
            cycle_ok = True
            backoff = cfg.poll_seconds

            now = time.monotonic()
            due = {"scheduled": scheduled_due, "follow_ups": follow_ups_due}
            for key, count in due.items():
                go, reason = states[key].should_trigger(count, now, cfg, last_trigger[key])
                if not go:
                    continue
                if reason == "floor":
                    LOG.info("floor reached for %s; sweeping anyway", key)
                elif reason == "stuck":
                    # Not necessarily an error: a user at their daily cap leaves
                    # rows legitimately pending until tomorrow. Warn so a real
                    # stall is visible in journalctl either way.
                    LOG.warning(
                        "%s still due for %s and unchanged since the last sweep; "
                        "backing off", count, key,
                    )
                else:
                    LOG.info("%s due for %s", count, key)
                # Stamp before the call: a slow or failing trigger must not spin
                # every cycle. The safety net covers a missed sweep.
                last_trigger[key] = now
                states[key].note_triggered(count, now, cfg, reason == "stuck")
                trigger(cfg, key)
        except Exception as err:  # noqa: BLE001
            LOG.error("cycle failed: %s: %s", type(err).__name__, err)
            try:
                if conn is not None:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            backoff = min(backoff * 2, 300)

        # Heartbeat only on a clean cycle, so a watcher that is running but
        # cannot reach the database still trips the alert.
        if cycle_ok:
            beat(cfg)

        stopper.wait(backoff if not cycle_ok else cfg.poll_seconds)

    if conn is not None and not conn.closed:
        conn.close()
    LOG.info("send-watcher stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

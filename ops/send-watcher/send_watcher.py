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

It asks for exactly one thing: `SELECT * FROM due_send_counts()`, a SECURITY
DEFINER function returning two integers. The `careervine_watcher` role has
EXECUTE on that function and no table privileges whatsoever. Someone who takes
this box gets two numbers and the ability to make CareerVine run a sweep it was
already going to run.

It does receive one thing that is not a count: the cron routes' response, which
carries `oldestDueScheduledAt` -- a real send time. It is never written down.
`trigger` logs the numeric counters from that response and drops every string
field, because journald keeps whatever it is handed for as long as the box
lives, and the version of this file that logged 300 raw bytes of the body on
every sweep was doing so under a header claiming the box could not hold a send
time (CAR-220).

── How it fails ────────────────────────────────────────────────────────────

Loudly and safely. QStash still runs both routes hourly as a safety net, so a
dead watcher degrades delivery to hourly rather than stopping it. A BetterStack
heartbeat is pinged after a cycle that both read the database AND got its
triggers accepted; when the pings stop, BetterStack emails. A dead box cannot
report its own death, which is why the alerting lives off-box.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import psycopg2

LOG = logging.getLogger("send-watcher")

# ── Keeping credentials out of the journal ──────────────────────────────────
#
# Everything here reaches the log through one generic `%s` of an exception, and
# two of the libraries put a credential in theirs. libpq echoes the whole
# connection string when URI parsing fails (verified: `postgresql:/` with one
# slash instead of two yields `invalid dsn: missing "=" after
# "postgresql:/user:pw@host..." in connection info string`), so a typo in
# /etc/careervine/send-watcher.env put the database password in cleartext in a
# journal that keeps it forever. urllib does the same with a HEARTBEAT_URL
# pasted without its scheme, and that URL *is* the alerting credential.
#
# This is a logger filter rather than a scrub() at each call site because the
# call site that leaked was one with no idea it was handling a secret --
# "cycle failed: %s: %s" -- and the next one will be too.

_SECRETS: set[str] = set()

REDACTED = "***"

# libpq's two ways of carrying a password. The URI form tolerates any number of
# slashes on purpose: the case that leaks is the one where a slash is missing.
_URI_PASSWORD = re.compile(r"(?i)\b(postgres(?:ql)?:/{0,3}[^:/@\s]+):[^@\s]+@")
_KEYWORD_PASSWORD = re.compile(r"(?i)\bpassword\s*=\s*('(?:[^'\\]|\\.)*'|\S+)")


def register_secret(value: str | None) -> None:
    """Have `scrub` blank this exact string wherever it appears in a log line."""
    # The 8-character floor keeps a short value from blanking unrelated text:
    # a password of "postgres" is a problem, a redactor that eats every
    # occurrence of "6543" is a worse one.
    if value and len(value) >= 8:
        _SECRETS.add(value)


def scrub(text: str) -> str:
    """Blank known secrets, then anything else shaped like a password."""
    for secret in _SECRETS:
        text = text.replace(secret, REDACTED)
    text = _URI_PASSWORD.sub(rf"\1:{REDACTED}@", text)
    return _KEYWORD_PASSWORD.sub(f"password={REDACTED}", text)


class _Redactor(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = scrub(message)
        if cleaned != message:
            # The args are already interpolated into `cleaned`; leaving them in
            # place would make the handler format an already-formatted string.
            record.msg, record.args = cleaned, ()
        return True


LOG.addFilter(_Redactor())


# ── Configuration (systemd EnvironmentFile) ─────────────────────────────────

def _env_number(name: str, default: float, minimum: float) -> float:
    """
    Read a numeric setting, or refuse to start.

    Three behaviours, each earned: an EMPTY value means unset, because
    `POLL_SECONDS=` in an EnvironmentFile is an empty string and float("")
    raised straight into systemd's 10s restart loop. A value BELOW the minimum
    is clamped and logged, because a watcher polling slightly slower than asked
    still delivers mail and one that refuses to boot does not -- and the
    unclamped POLL_SECONDS=0 was an unthrottled loop against both Supabase and
    Vercel. A value that is NOT A NUMBER is a typo whose intent nothing can
    guess, so it stops startup with the variable and the value named.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return float(default)
    try:
        value = float(raw)
    except ValueError:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from None
    if not math.isfinite(value):
        raise SystemExit(f"{name} must be a finite number, got {raw!r}")
    if value < minimum:
        LOG.warning("%s=%s is below the minimum of %s; using %s", name, raw, minimum, minimum)
        return float(minimum)
    return value


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
    # Unconditional ceiling on trigger rate, independent of the progress signal
    # (CAR-220). The backoff decides how slow to go when nothing moves; this
    # decides how fast we are ever willing to go when it does.
    min_trigger_seconds: float
    # Consecutive failed triggers on one route before the heartbeat stops.
    trigger_failure_tolerance: int

    def __post_init__(self) -> None:
        # Every Config teaches the log filter what to blank, including one built
        # by a caller that never went through from_env. Registering at each use
        # site instead would make redaction depend on call order, which is the
        # kind of guarantee that holds until someone adds a log line.
        register_secret(self.db_dsn)
        register_secret(self.cron_secret)
        register_secret(self.heartbeat_url)

    @staticmethod
    def from_env() -> "Config":
        missing = [
            k for k in ("WATCHER_DB_DSN", "APP_BASE_URL", "CRON_TRIGGER_SECRET")
            if not os.environ.get(k)
        ]
        if missing:
            raise SystemExit(f"missing required env: {', '.join(missing)}")

        # Registered before the value is used for anything, because the very
        # next statement is one of the places libpq quotes it back.
        dsn = os.environ["WATCHER_DB_DSN"]
        register_secret(dsn)
        try:
            parsed = psycopg2.extensions.parse_dsn(dsn)
        except Exception as err:  # noqa: BLE001 - psycopg2 raises ProgrammingError
            raise SystemExit(
                f"WATCHER_DB_DSN is not a valid libpq connection string: {scrub(str(err))}"
            ) from None
        register_secret(parsed.get("password"))

        # Must be the www host: the apex 307-redirects, and urllib refuses to
        # replay a POST across a redirect, so every trigger would fail (rule 29
        # names the same host requirement for a different reason -- undici, in
        # the app, strips Authorization on the cross-origin hop).
        base_url = os.environ["APP_BASE_URL"].rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            # urllib raises `unknown url type` on every trigger otherwise, and a
            # daemon that can never deliver should not start.
            raise SystemExit(f"APP_BASE_URL must start with http:// or https://, got {base_url!r}")

        # A stuck-backoff floor of zero leaves `max(cooldown * 2, 0)` at zero
        # forever, which is the runaway RouteState exists to prevent, re-enabled
        # through config. The ceiling cannot sit below the floor.
        stuck_min = _env_number("STUCK_MIN_SECONDS", 60.0, minimum=5.0)
        stuck_max = _env_number("STUCK_MAX_SECONDS", 900.0, minimum=stuck_min)
        # Default 0: a fresh arrival should still be served on the next poll.
        # Raise it if Vercel invocation volume ever needs a harder cap.
        min_trigger = _env_number("MIN_TRIGGER_SECONDS", 0.0, minimum=0.0)
        return Config(
            db_dsn=dsn,
            app_base_url=base_url,
            cron_secret=os.environ["CRON_TRIGGER_SECRET"],
            poll_seconds=_env_number("POLL_SECONDS", 15.0, minimum=1.0),
            heartbeat_url=os.environ.get("HEARTBEAT_URL") or None,
            # Under a minute, the floor turns "nothing due" into a sweep on
            # nearly every poll: the Vercel bill this design exists to avoid.
            floor_seconds=_env_number("FLOOR_SECONDS", 900.0, minimum=60.0),
            stuck_min_seconds=stuck_min,
            stuck_max_seconds=stuck_max,
            min_trigger_seconds=min_trigger,
            trigger_failure_tolerance=int(
                _env_number("TRIGGER_FAILURE_TOLERANCE", 3, minimum=1)
            ),
        )


ROUTES = {
    "scheduled": "/api/cron/send-scheduled-emails",
    "follow_ups": "/api/cron/send-follow-ups",
}

# libpq settings for a connection that has to survive being idle between polls.
#
# `connect_timeout` bounded only the handshake. A socket that dies while we are
# idle -- the pooler recycling it, a NAT dropping the flow -- left the next
# cur.execute() parked in recv() until tcp_retries2 gave up ~15 minutes later,
# with conn.closed still 0, so the reconnect branch in main() never fired. The
# daemon was dark for that whole window: no polls, no beats, no triggers, and a
# SIGTERM it could not answer either.
#
# keepalives_* make the kernel probe an idle socket and fail it in ~25s.
# tcp_user_timeout covers the half keepalives do not -- data already sent and
# unacknowledged -- by capping how long it may stay that way. It needs libpq
# >= 12 and takes effect on Linux; the A1 runs Ubuntu's python3-psycopg2
# against the system libpq.
CONNECT_KWARGS = {
    "connect_timeout": 10,
    "keepalives": 1,
    "keepalives_idle": 10,
    "keepalives_interval": 5,
    "keepalives_count": 3,
    "tcp_user_timeout": 30_000,
}

# Bounds the other stall: a healthy socket where the answer simply never comes
# (a lock, a slow plan). Generous for a function that returns two integers; the
# point is a ceiling, not a target.
STATEMENT_TIMEOUT_MS = 10_000

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

def read_due_counts(conn) -> tuple[tuple[int, str | None], tuple[int, str | None]]:
    """
    ((scheduled_due, scheduled_newest), (follow_ups_due, follow_ups_newest)).

    The only query this process ever makes. The newest due instant rides along
    because a bare count is not a usable progress signal — see RouteState.
    """
    with conn.cursor() as cur:
        # SET LOCAL rather than a connect-time `options=-c statement_timeout`:
        # the DSN points at Supavisor in transaction-pooling mode, and a pooler
        # that rejects an unknown startup parameter rejects the whole
        # connection, turning a timeout setting into an outage. SET LOCAL rides
        # inside the transaction psycopg2 opens for the SELECT below, so it
        # applies whatever the pooling mode turns out to be.
        cur.execute("SET LOCAL statement_timeout = %s", (STATEMENT_TIMEOUT_MS,))
        cur.execute(
            "SELECT scheduled_due, follow_ups_due, scheduled_newest, follow_ups_newest "
            "FROM public.due_send_counts()"
        )
        row = cur.fetchone()
    # Transaction-mode pooling: leaving a transaction open holds a server slot.
    conn.commit()
    if not row:
        return ((0, None), (0, None))
    def stamp(v):
        # psycopg2 hands back a datetime; tests and any future driver may hand
        # back the ISO string already. Only the equality matters downstream.
        if v is None:
            return None
        return v.isoformat() if hasattr(v, "isoformat") else str(v)
    return ((int(row[0]), stamp(row[2])), (int(row[1]), stamp(row[3])))


def summarize_response(raw: bytes) -> str:
    """
    Render a cron response as its numeric counters and nothing else.

    These bodies carry `oldestDueScheduledAt`: a real person's send time, and
    the previous version wrote 300 raw bytes of one to the journal on every
    sweep. Numbers and booleans only, so a string field added upstream cannot
    quietly reintroduce that -- and maxDelayMs, the lateness signal actually
    worth watching, is a duration and survives the filter.
    """
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return f"<{len(raw)} bytes, not json>"
    if not isinstance(parsed, dict):
        return f"<{len(raw)} bytes, not an object>"
    counters = " ".join(
        f"{key}={value}" for key, value in sorted(parsed.items())
        if isinstance(value, (int, float))
    )
    return counters or f"<{len(raw)} bytes, no numeric counters>"


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
            LOG.info(
                "triggered %s -> %s %s",
                route_key, res.status, summarize_response(res.read(2000)),
            )
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        # The status is the diagnosis: 401 means the bearer is wrong or the app
        # has not deployed it yet, 307 means APP_BASE_URL is the apex rather
        # than www. Loud, because the hourly safety net is now the only thing
        # delivering mail. The body is summarised like any other -- an error
        # body persists just as long and Next puts request detail in some.
        LOG.error(
            "trigger %s failed: HTTP %s %s",
            route_key, err.code, summarize_response(err.read(500)),
        )
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
    conn = psycopg2.connect(cfg.db_dsn, **CONNECT_KWARGS)
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
    by whether work exists.

    ── Why the signal is (count, newest) and not count alone (CAR-220) ─────

    Comparing counts is sound only while the baseline is zero. With a
    permanently-undeliverable row present, any window in which one row drains
    and another arrives nets to an unchanged count, reads as "no progress", and
    holds the watcher on its cooldown. A simulation of this loop put a healthy
    user's mail 400s late because a DIFFERENT user had a bounced address, with
    the worst case bounded only by `stuck_max_seconds`.

    The newest due instant fixes that and the oldest would not: the poison row
    IS the oldest, so it pins that value exactly as hard as it pins the count.
    The newest moves whenever fresh work comes due, which is the thing worth
    reacting to, and a stale row sitting behind it cannot hold it down.

    `min_trigger_seconds` is a separate, unconditional ceiling. The progress
    signal decides how SLOW to go when nothing is moving; this decides how FAST
    we are ever willing to go when it is. Without it a queue that changes on
    most polls triggers on most polls, which is the invocation volume this
    design exists to avoid.
    """

    def __init__(self) -> None:
        self.cooldown = 0.0
        self.next_ok = 0.0
        # (count, newest) as they stood when we last POSTed. Comparing against
        # the last TRIGGER rather than the last POLL is the whole trick:
        # escalating per poll would double the backoff four times inside a
        # single 60s cooldown at a 15s poll rate, so any momentary stall would
        # slam straight to the 15-minute cap and stay there.
        self.signal_at_last_trigger: tuple[int, str | None] | None = None

    def _reset(self) -> None:
        self.cooldown = 0.0
        self.next_ok = 0.0
        self.signal_at_last_trigger = None

    def should_trigger(
        self,
        signal: tuple[int, str | None],
        now: float,
        cfg: Config,
        last_trigger: float,
    ) -> tuple[bool, str]:
        count, _newest = signal
        if count == 0:
            self._reset()
            if now - last_trigger >= cfg.floor_seconds:
                return True, "floor"
            return False, ""

        # Any movement at all — count up or down, or fresh work arriving behind
        # a stuck row — means something is happening. Serve it promptly and drop
        # whatever penalty we accrued. Only a signal EXACTLY unchanged since our
        # last POST is evidence of a backlog no sweep can shift.
        moved = (
            self.signal_at_last_trigger is not None
            and signal != self.signal_at_last_trigger
        )
        if moved:
            self._reset()

        # The unconditional floor. Applies even to "moved", so a rapidly
        # churning queue cannot trigger on every poll.
        if now < self.next_ok or now - last_trigger < cfg.min_trigger_seconds:
            return False, ""
        stuck = signal == self.signal_at_last_trigger
        return True, "stuck" if stuck else "due"

    def note_triggered(
        self,
        signal: tuple[int, str | None],
        now: float,
        cfg: Config,
        stuck: bool,
    ) -> None:
        if stuck:
            self.cooldown = min(
                max(self.cooldown * 2, cfg.stuck_min_seconds),
                cfg.stuck_max_seconds,
            )
        self.signal_at_last_trigger = signal
        self.next_ok = now + self.cooldown


def dispatch(cfg: Config, due, states, last_trigger, fail_streak) -> None:
    """Decide and fire this poll's triggers, updating the pacing state in place."""
    for key, signal in due.items():
        count = signal[0]
        # Read the clock per route, not once per cycle: trigger() below blocks
        # for up to its full 90s HTTP timeout, so a shared `now` stamps the
        # second route up to 90s in the past -- shortening its cooldown and
        # bringing its next floor sweep forward by the same amount.
        now = time.monotonic()
        go, reason = states[key].should_trigger(signal, now, cfg, last_trigger[key])
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
        states[key].note_triggered(signal, now, cfg, reason == "stuck")
        # The result is what tells the heartbeat whether mail is actually going
        # out. Per route, because a watcher whose follow-ups always fail and
        # whose scheduled sends always succeed is half broken, and one shared
        # counter would be cleared by the healthy half every cycle.
        if trigger(cfg, key):
            fail_streak[key] = 0
        else:
            fail_streak[key] += 1


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
    # Start the floor clock at now, not at a 0.0 "never triggered" sentinel:
    # time.monotonic() counts from BOOT on Linux (verified -- it tracks
    # /proc/uptime), so 0.0 read as "last swept `uptime` seconds ago" and every
    # start on a box up longer than FLOOR_SECONDS swept both routes on its first
    # cycle with nothing due. There is deliberately no startup sweep to replace
    # it: Restart=always with RestartSec=10 would turn a crash loop into a sweep
    # every 10 seconds, and anything genuinely due is picked up from the counts
    # within one poll anyway.
    started = time.monotonic()
    last_trigger = {key: started for key in ROUTES}
    states = {key: RouteState() for key in ROUTES}
    # Consecutive failed POSTs, per route. The heartbeat is a claim that mail is
    # going out, and trigger()'s result used to be discarded entirely: with
    # Postgres healthy and Vercel returning 500, this process beat "healthy"
    # every 15 seconds while delivering nothing.
    fail_streak = {key: 0 for key in ROUTES}
    beat_suppressed = False
    # Exponential backoff on DB trouble so a Supabase blip does not become a
    # reconnect storm. Reset to the base interval on the first good read.
    backoff = cfg.poll_seconds

    while not stopper.stopped:
        cycle_ok = False
        try:
            if conn is None or conn.closed:
                conn = connect(cfg)
                LOG.info("database connection established")
            scheduled_sig, follow_ups_sig = read_due_counts(conn)
            cycle_ok = True
            backoff = cfg.poll_seconds

            due = {"scheduled": scheduled_sig, "follow_ups": follow_ups_sig}
            dispatch(cfg, due, states, last_trigger, fail_streak)
        except Exception as err:  # noqa: BLE001
            LOG.error("cycle failed: %s: %s", type(err).__name__, err)
            try:
                if conn is not None:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            backoff = min(backoff * 2, 300)

        # The heartbeat answers "is mail going out", which takes both halves: a
        # clean database read (a watcher that cannot reach Postgres must trip
        # the alert) and triggers that are landing. One failed POST is a cold
        # start rather than an outage, so suppression needs
        # TRIGGER_FAILURE_TOLERANCE consecutive failures on one route, and a
        # single success on that route clears it.
        broken = [k for k, n in fail_streak.items() if n >= cfg.trigger_failure_tolerance]
        if broken and not beat_suppressed:
            LOG.error(
                "suppressing heartbeat: %s consecutive failed triggers on %s; "
                "delivery is down to the hourly QStash net",
                cfg.trigger_failure_tolerance, ", ".join(broken),
            )
        elif beat_suppressed and not broken:
            LOG.info("triggers are landing again; resuming heartbeat")
        beat_suppressed = bool(broken)

        if cycle_ok and not broken:
            beat(cfg)

        stopper.wait(backoff if not cycle_ok else cfg.poll_seconds)

    if conn is not None and not conn.closed:
        conn.close()
    LOG.info("send-watcher stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

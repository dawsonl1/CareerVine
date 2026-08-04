#!/usr/bin/env python3
"""
Tests for the send watcher (CAR-215, extended by the CAR-220 review).

Run: python3 ops/send-watcher/test_send_watcher.py

Deliberately dependency-free plain asserts rather than pytest, and not wired
into CI, which is Node-only. Everything here runs with no pip installs: the one
third-party import the daemon has, psycopg2, is stubbed below when absent.

The pacing tests exist because of a bug found by running the daemon against a
mock endpoint that returned 200 without draining the queue: the watcher
triggered on every single cycle. In production that is not hypothetical,
because "due" does not mean "sendable" (daily cap reached, bounced address
awaiting its NDR).

The rest exist because the CAR-220 review found five more defects in the parts
that had no tests at all -- `main`, `connect`, `read_due_counts`, `trigger`,
`beat` -- and every one of them was a defect that only shows up in the wiring
between those functions, not inside any of them. So most of what follows drives
`main()` end to end with the database and HTTP mocked out, rather than testing
helpers in isolation.
"""

import contextlib
import io
import logging
import os
import re
import signal
import sys
import types
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

# psycopg2 is imported at module scope by the daemon but nothing here needs a
# real one. The stub carries an `extensions` namespace because `Config.from_env`
# validates the DSN through `psycopg2.extensions.parse_dsn`; tests that care
# about parse failures install their own fake over it.
try:
    import psycopg2  # noqa: F401
except ModuleNotFoundError:  # pragma: no cover - only on a box without psycopg2
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.extensions = types.ModuleType("psycopg2.extensions")
    psycopg2.extensions.parse_dsn = lambda dsn: {}
    sys.modules["psycopg2"] = psycopg2
    sys.modules["psycopg2.extensions"] = psycopg2.extensions

import send_watcher  # noqa: E402
from send_watcher import Config, RouteState  # noqa: E402

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def check_true(label, actual):
    check(label, bool(actual), True)


# ── Fixtures ────────────────────────────────────────────────────────────────

# A password long enough to be worth redacting, in a DSN shaped like the real
# one. Both appear verbatim in libpq's error text when the DSN is malformed.
PASSWORD = "s3cr3t-watcher-pw"
DSN = f"postgresql://careervine_watcher.abc:{PASSWORD}@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require"
HEARTBEAT_TOKEN = "hb-token-abcdef123456"


def make_cfg(**over):
    values = dict(
        db_dsn=DSN, app_base_url="https://www.careervine.app", cron_secret="shh",
        poll_seconds=15, heartbeat_url=None,
        floor_seconds=900, stuck_min_seconds=60, stuck_max_seconds=900,
        trigger_failure_tolerance=3, min_trigger_seconds=0,
    )
    values.update(over)
    return Config(**values)


CFG = make_cfg()


class Clock:
    """
    Hand-cranked stand-in for time.monotonic().

    Starts at a value a real box would report, not at zero: on Linux
    time.monotonic() counts from BOOT (verified against /proc/uptime), which is
    the whole substance of the "floor sweep on every start" defect. A test clock
    starting near zero would hide it.
    """

    def __init__(self, start=500_000.0):  # ~5.8 days of uptime
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += float(seconds)


@contextlib.contextmanager
def patched(obj, name, value):
    missing = object()
    old = getattr(obj, name, missing)
    setattr(obj, name, value)
    try:
        yield
    finally:
        if old is missing:
            delattr(obj, name)
        else:
            setattr(obj, name, old)


@contextlib.contextmanager
def environment(**values):
    """Set env vars for the body; None means "unset". Also clears secret state."""
    old = {k: os.environ.get(k) for k in values}
    for k, v in values.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    send_watcher._SECRETS.clear()
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        send_watcher._SECRETS.clear()


class Records(logging.Handler):
    """Captures what would have gone to journald, after any redaction."""

    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())

    def text(self):
        return "\n".join(self.lines)


@contextlib.contextmanager
def captured_log():
    """Take the daemon's log records instead of letting them hit stdout."""
    handler = Records()
    send_watcher.LOG.addHandler(handler)
    propagate = send_watcher.LOG.propagate
    level = send_watcher.LOG.level
    send_watcher.LOG.propagate = False
    send_watcher.LOG.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        send_watcher.LOG.removeHandler(handler)
        send_watcher.LOG.propagate = propagate
        send_watcher.LOG.setLevel(level)


class FakeCursor:
    def __init__(self, executed, row):
        self.executed = executed
        self.row = row

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self.row


class FakeConn:
    def __init__(self, row=(0, 0)):
        self.closed = 0
        self.executed = []
        self.commits = 0
        self.row = row

    def cursor(self):
        return FakeCursor(self.executed, self.row)

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = 1


class FakeResponse:
    def __init__(self, body, status=200):
        self.body = body
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, n=None):
        return self.body if n is None else self.body[:n]


class Run:
    def __init__(self, fired, beats, log):
        self.fired = fired      # [(cycle, route_key), ...]
        self.beats = beats      # [cycle, ...]
        self.log = log


def drive_main(
    *, cycles, counts=lambda c: (0, 0), trigger_ok=lambda c, k: True,
    clock=None, env=None, connect_error=None, read_error=None,
    trigger_takes_seconds=0.0,
):
    """
    Run `main()` for a fixed number of cycles with Postgres and HTTP mocked.

    The loop's stop condition rides on `Stopper.wait`, not on the query, so a
    cycle that dies before its read still counts and cannot hang the suite.
    """
    clock = clock or Clock()
    cycle = [1]
    fired, beats = [], []

    def fake_connect(cfg):
        if connect_error is not None:
            raise connect_error
        return FakeConn()

    def fake_read(conn, *a, **kw):
        if read_error is not None:
            raise read_error
        # Call sites give bare counts for readability; read_due_counts returns
        # (count, newest) pairs since CAR-220, so normalize here rather than
        # rewriting every scenario.
        return tuple((v, None) if isinstance(v, int) else v for v in counts(cycle[0]))

    def fake_trigger(cfg, key):
        fired.append((cycle[0], key))
        clock.advance(trigger_takes_seconds)
        return trigger_ok(cycle[0], key)

    def fake_beat(cfg):
        beats.append(cycle[0])

    def fake_wait(self, seconds):
        clock.advance(seconds)
        if cycle[0] >= cycles:
            self.stopped = True
        else:
            cycle[0] += 1

    base_env = {
        "WATCHER_DB_DSN": DSN,
        "APP_BASE_URL": "https://www.careervine.app",
        "CRON_TRIGGER_SECRET": "shh",
        "HEARTBEAT_URL": f"https://uptime.betterstack.com/api/v1/heartbeat/{HEARTBEAT_TOKEN}",
    }
    base_env.update(env or {})

    old_signals = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
    with contextlib.ExitStack() as stack:
        stack.enter_context(environment(**base_env))
        log = stack.enter_context(captured_log())
        stack.enter_context(patched(send_watcher.time, "monotonic", clock))
        stack.enter_context(patched(send_watcher, "connect", fake_connect))
        stack.enter_context(patched(send_watcher, "read_due_counts", fake_read))
        stack.enter_context(patched(send_watcher, "trigger", fake_trigger))
        stack.enter_context(patched(send_watcher, "beat", fake_beat))
        stack.enter_context(patched(send_watcher.Stopper, "wait", fake_wait))
        try:
            send_watcher.main()
        finally:
            for sig, handler in old_signals.items():
                signal.signal(sig, handler)
    return Run(fired, beats, log)


# ── Pacing (CAR-215) ────────────────────────────────────────────────────────

def test_idle_does_not_trigger_until_the_floor():
    st, now = RouteState(), 1000.0
    go, _ = st.should_trigger(sig(0), now, CFG, last_trigger=now)
    check("idle: no trigger", go, False)
    # Floor reached -> sweep anyway, so a row the counts cannot see still goes.
    go, reason = st.should_trigger(sig(0), now + CFG.floor_seconds, CFG, last_trigger=now)
    check("idle: floor sweep", (go, reason), (True, "floor"))


def sig(count, newest="2026-08-04T00:00:00+00:00"):
    """(count, newest) as read_due_counts returns it. CAR-220 made the progress
    signal a pair so a permanently-stuck row cannot pin it."""
    return (count, newest if count else None)


def fire_signal(st, signal, now, last_trigger=0.0):
    """fire(), but with the (count, newest) pair given explicitly."""
    go, reason = st.should_trigger(signal, now, CFG, last_trigger)
    if go:
        st.note_triggered(signal, now, CFG, reason == "stuck")
    return go, reason


def fire(st, count, now, last_trigger=0.0):
    """should_trigger + note_triggered, the way the main loop pairs them."""
    go, reason = st.should_trigger(sig(count), now, CFG, last_trigger)
    if go:
        st.note_triggered(sig(count), now, CFG, reason == "stuck")
    return go, reason


def test_new_work_triggers_immediately():
    st, now = RouteState(), 1000.0
    st.should_trigger(sig(0), now, CFG, last_trigger=now)
    go, reason = st.should_trigger(sig(1), now + 15, CFG, last_trigger=now)
    check("new work triggers", (go, reason), (True, "due"))


def test_backlog_that_will_not_drain_backs_off():
    """The runaway case: count stays at 1 forever (user at their daily cap)."""
    st, now = RouteState(), 1000.0
    check("first trigger", fire(st, 1, now)[0], True)

    # Unchanged on the next poll -> recognised as stuck and penalised.
    now += CFG.poll_seconds
    go, reason = fire(st, 1, now)
    check("second: stuck", (go, reason), (True, "stuck"))
    check("second: cooldown floor", st.cooldown, 60)

    # Still inside that cooldown -> suppressed, and NOT escalated again just
    # for being polled (the per-poll escalation bug these tests caught).
    now += CFG.poll_seconds
    check("third: suppressed inside cooldown", fire(st, 1, now)[0], False)
    check("polling alone does not escalate", st.cooldown, 60)

    seen = []
    for _ in range(8):
        now += st.cooldown + 1
        if fire(st, 1, now)[0]:
            seen.append(st.cooldown)
    check("backoff doubles then caps", seen, [120, 240, 480, 900, 900, 900, 900, 900])


def test_progress_snaps_back_to_immediate():
    """A shrinking backlog must not inherit the stuck-state penalty."""
    st, now = RouteState(), 1000.0
    fire(st, 5, now)
    now += CFG.poll_seconds
    fire(st, 5, now)  # unchanged -> penalised to 60s
    check("penalised", st.cooldown, 60)

    # The sweep works and the count drops. Both the cooldown AND the gate must
    # clear, or the next trigger waits out a penalty it no longer deserves.
    now += CFG.poll_seconds
    go, reason = st.should_trigger(sig(2), now, CFG, last_trigger=now)
    check("progress resets cooldown", st.cooldown, 0.0)
    check("progress triggers again", (go, reason), (True, "due"))


def test_new_arrivals_during_a_stall_are_served():
    """A rising count is new work, not evidence of a stall."""
    st, now = RouteState(), 1000.0
    fire(st, 1, now)
    now += CFG.poll_seconds
    fire(st, 1, now)  # stuck -> 60s gate
    check("penalised", st.cooldown, 60)

    now += CFG.poll_seconds  # inside the gate, but mail just came due
    go, reason = st.should_trigger(sig(4), now, CFG, last_trigger=now)
    check("arrival breaks the gate", (go, reason), (True, "due"))
    check("arrival clears the penalty", st.cooldown, 0.0)


def test_draining_to_zero_then_new_work_is_fast():
    """The normal happy path, which is what the whole feature is for."""
    st, now = RouteState(), 1000.0
    fire(st, 1, now)
    now += CFG.poll_seconds
    st.should_trigger(sig(0), now, CFG, last_trigger=now)  # drained
    check("drained resets", st.cooldown, 0.0)

    now += CFG.poll_seconds
    go, reason = st.should_trigger(sig(3), now, CFG, last_trigger=now)
    check("next arrival is immediate", (go, reason), (True, "due"))


# ── A stuck row must not tax other users (CAR-220) ──────────────────────────

def test_a_poison_row_does_not_pin_the_progress_signal():
    """
    A bounced recipient leaves a scheduled email pending forever (detectBounces
    now cancels those, but a daily-cap row behaves the same until tomorrow).

    With a count-only signal, a window where that row persists while another
    drains and a third arrives nets to an unchanged count, reads as "no
    progress", and holds the watcher on its 900s cooldown -- taxing an unrelated
    user with exactly the latency this design removes. The newest-due instant
    moves when fresh work lands, and unlike the OLDEST it is not pinned by the
    stale row sitting behind it.
    """
    st = RouteState()
    now = 1000.0

    # One permanently-stuck row. Two identical reads earn a backoff.
    fire_signal(st, (1, "T0"), now)
    now += CFG.poll_seconds
    go, reason = fire_signal(st, (1, "T0"), now)
    check("unchanged signal is stuck", (go, reason), (True, "stuck"))
    check("and is penalised", st.cooldown, CFG.stuck_min_seconds)

    # Now one drains and one arrives inside the same window: count is IDENTICAL,
    # but the newest instant moved. Count alone would have suppressed this.
    now += CFG.poll_seconds
    go, reason = st.should_trigger((1, "T1"), now, CFG, last_trigger=now)
    check("same count, newer work still triggers", (go, reason), (True, "due"))
    check("and the penalty is dropped", st.cooldown, 0.0)


def test_the_oldest_instant_would_not_have_worked():
    """
    Pins the reasoning, not just the outcome: the poison row is the OLDEST due
    row, so an oldest-based signal is pinned exactly as hard as a count. This
    asserts the pair we actually use changes in the case that matters.
    """
    stuck_then_arrival = [(2, "T5"), (2, "T9")]
    check("newest distinguishes them", stuck_then_arrival[0] != stuck_then_arrival[1], True)
    oldest_view = [(2, "T0"), (2, "T0")]  # what an oldest-based signal would see
    check("oldest would not", oldest_view[0] != oldest_view[1], False)


# ── Startup must not sweep (defect 1) ───────────────────────────────────────

def test_a_fresh_start_does_not_sweep_a_box_that_has_uptime():
    """
    The `0.0` "never triggered" sentinel was read against a BOOT-relative clock,
    so `now - 0.0 >= floor_seconds` was true on the first cycle of any box up
    longer than 15 minutes: two Vercel invocations on every restart, with
    nothing due and no user waiting on them.
    """
    run = drive_main(cycles=3, counts=lambda c: (0, 0))
    check("no sweep with nothing due", run.fired, [])


def test_the_floor_still_fires_once_its_interval_has_actually_elapsed():
    """Guards the over-correction: the floor exists and must still arrive."""
    # 15s polls, 900s floor -> the 61st cycle is the first at or past it.
    run = drive_main(cycles=61, counts=lambda c: (0, 0))
    check("floor sweeps exactly once, on time", run.fired,
          [(61, "scheduled"), (61, "follow_ups")])


# ── Per-route clock (defect 7) ──────────────────────────────────────────────

def test_each_route_is_stamped_with_the_clock_at_its_own_trigger():
    """
    `trigger()` blocks for up to its 90s HTTP timeout. A `now` captured once per
    cycle therefore stamps the second route up to 90s in the past, shortening
    its cooldown and firing its next floor sweep early.
    """
    clock = Clock()
    states = {k: RouteState() for k in send_watcher.ROUTES}
    last_trigger = {k: clock() - 10_000 for k in send_watcher.ROUTES}
    fail_streak = {k: 0 for k in send_watcher.ROUTES}

    def slow_trigger(cfg, key):
        clock.advance(90)  # the full urlopen timeout
        return True

    with patched(send_watcher.time, "monotonic", clock), \
            patched(send_watcher, "trigger", slow_trigger), \
            captured_log():
        send_watcher.dispatch(
            CFG, {"scheduled": sig(1), "follow_ups": sig(1)}, states, last_trigger, fail_streak,
        )

    check("second route is stamped after the first call returns",
          last_trigger["follow_ups"] - last_trigger["scheduled"], 90.0)


# ── Heartbeat honesty (defect 4) ────────────────────────────────────────────

def test_a_watcher_whose_triggers_all_fail_stops_beating():
    """
    `trigger()`'s bool was discarded, so with Postgres healthy and Vercel
    returning 500 the daemon beat "healthy" every 15s while delivering nothing.
    A rising count keeps the pacing gate open, so every cycle here attempts both
    routes and every attempt fails.
    """
    run = drive_main(
        cycles=6, counts=lambda c: (c, c), trigger_ok=lambda c, k: False,
    )
    check("beats stop once the failures are no longer a blip", run.beats, [1, 2])
    check_true("the suppression says why",
               "heartbeat" in run.log.text() and "scheduled" in run.log.text())


def test_the_heartbeat_tolerates_a_blip_and_returns_after_a_recovery():
    """
    One bad POST is a Vercel cold start, not an outage: it must not page
    anyone. Four in a row is an outage. A success must clear the streak.
    """
    run = drive_main(
        cycles=6, counts=lambda c: (c, c), trigger_ok=lambda c, k: c > 4,
    )
    check("blip beats, sustained failure does not, recovery resumes",
          run.beats, [1, 2, 5, 6])


def test_a_database_that_cannot_be_read_still_stops_the_heartbeat():
    """The original alerting contract, which the trigger-health change must keep."""
    run = drive_main(cycles=3, read_error=RuntimeError("connection reset"))
    check("no beats while the read fails", run.beats, [])
    # Without this the assertion above would also pass on a run that never
    # cycled at all, which is how an absence test quietly stops testing.
    check("the cycles really ran", run.log.text().count("cycle failed"), 3)


def test_dispatch_counts_failures_per_route():
    """
    Per route, not per cycle: a watcher where follow-ups always fail and
    scheduled always succeeds is half-broken, and a shared counter would be
    reset by the healthy half on every cycle.
    """
    clock = Clock()
    states = {k: RouteState() for k in send_watcher.ROUTES}
    last_trigger = {k: clock() for k in send_watcher.ROUTES}
    fail_streak = {k: 0 for k in send_watcher.ROUTES}

    with patched(send_watcher.time, "monotonic", clock), \
            patched(send_watcher, "trigger", lambda cfg, key: key == "scheduled"), \
            captured_log():
        for n in range(1, 4):
            send_watcher.dispatch(
                CFG, {"scheduled": sig(n), "follow_ups": sig(n)}, states, last_trigger, fail_streak,
            )

    check("healthy route stays at zero", fail_streak["scheduled"], 0)
    check("broken route accumulates", fail_streak["follow_ups"], 3)


# ── Connection and query must be bounded (defect 2) ─────────────────────────

def test_connect_bounds_a_socket_that_dies_while_idle():
    """
    `connect_timeout` only ever bounded the handshake. A half-open socket left
    `cur.execute()` parked in recv() for ~15 minutes (tcp_retries2) with
    `conn.closed` still 0, so the reconnect branch never fired and the daemon
    was dark: no polls, no beats, no triggers, and SIGTERM could not interrupt.
    """
    seen = {}

    def fake_connect(dsn, **kwargs):
        seen.update(kwargs)
        seen["dsn"] = dsn
        return FakeConn()

    with patched(send_watcher.psycopg2, "connect", fake_connect):
        send_watcher.connect(CFG)

    check("keepalives on", seen.get("keepalives"), 1)
    check_true("idle probes start inside one poll interval",
               0 < float(seen.get("keepalives_idle", 0)) <= 60)
    check_true("probes give up", int(seen.get("keepalives_count", 0)) > 0)
    check_true("in-flight data is bounded too",
               0 < int(seen.get("tcp_user_timeout", 0)) <= 120_000)
    check_true("handshake still bounded", int(seen.get("connect_timeout", 0)) > 0)


def test_read_due_counts_bounds_the_query_itself():
    """
    Keepalives cannot bound a server-side stall (a lock, a slow function): the
    socket is healthy, the answer just never comes. That is what
    statement_timeout is for, and it has to ride inside the transaction because
    the DSN points at Supavisor in transaction-pooling mode.
    """
    conn = FakeConn(row=(3, 4, "2026-08-04T10:00:00+00:00", None))
    check("reads both counts and both newest stamps", send_watcher.read_due_counts(conn),
          ((3, "2026-08-04T10:00:00+00:00"), (4, None)))

    statements = [sql for sql, _ in conn.executed]
    timeouts = [i for i, s in enumerate(statements) if "statement_timeout" in s]
    selects = [i for i, s in enumerate(statements) if "due_send_counts" in s]
    check_true("a statement timeout is set", timeouts)
    check_true("the query still runs", selects)
    check_true("the timeout is set before the query", timeouts and selects
               and min(timeouts) < min(selects))
    check_true("the timeout is local to this transaction",
               any("LOCAL" in s.upper() for s in statements))
    check("transaction is closed (pooled connections hold a server slot)",
          conn.commits, 1)


# ── Secrets must not reach the journal (defect 3) ───────────────────────────

def test_a_malformed_dsn_fails_fast_without_echoing_the_password():
    """
    libpq echoes the whole connection string when URI parsing fails -- verified:
    a single-slash typo produces `invalid dsn: missing "=" after
    "postgresql:/user:pw@host..." in connection info string`. journald keeps
    that forever, so a typo in the env file publishes the database password.
    """
    typo = DSN.replace("postgresql://", "postgresql:/")

    def exploding_parse_dsn(dsn):
        raise ValueError(f'invalid dsn: missing "=" after "{dsn}" in connection info string')

    with environment(WATCHER_DB_DSN=typo, APP_BASE_URL="https://www.careervine.app",
                     CRON_TRIGGER_SECRET="shh"), \
            patched(send_watcher.psycopg2.extensions, "parse_dsn", exploding_parse_dsn), \
            captured_log():
        try:
            send_watcher.Config.from_env()
            message = None
        except SystemExit as err:
            message = str(err)

    check_true("startup refuses a DSN libpq cannot parse", message is not None)
    check_true("and names the variable", "WATCHER_DB_DSN" in (message or ""))
    check("the password is not in the message", PASSWORD in (message or ""), False)


def test_a_connection_failure_does_not_publish_the_dsn():
    """The same echo arrives through the cycle handler when libpq fails later."""
    boom = RuntimeError(
        f'invalid dsn: missing "=" after "{DSN}" in connection info string'
    )
    run = drive_main(cycles=2, connect_error=boom)
    check("the failure is still reported", "cycle failed" in run.log.text(), True)
    check("but not with the password", PASSWORD in run.log.text(), False)
    check("nor with the raw DSN", DSN in run.log.text(), False)


def test_the_heartbeat_token_is_not_logged_when_the_url_is_wrong():
    """
    A HEARTBEAT_URL pasted without its scheme makes urllib raise
    `unknown url type: '<the whole url>'` (verified), and that URL is itself the
    credential: anyone reading the journal can silence the alerting.
    """
    cfg = make_cfg(heartbeat_url=f"uptime.betterstack.com/api/v1/heartbeat/{HEARTBEAT_TOKEN}")
    with captured_log() as log:
        # Returning at all is half the contract: alerting must never be able to
        # take down the thing it is watching.
        send_watcher.beat(cfg)
    check("the failure is reported", "heartbeat failed" in log.text(), True)
    check("the token is not", HEARTBEAT_TOKEN in log.text(), False)

    def explode(*_a, **_kw):
        raise AssertionError("no heartbeat is configured; nothing should be sent")

    with patched(urllib.request, "urlopen", explode), captured_log() as log:
        send_watcher.beat(make_cfg(heartbeat_url=None))
    check("no URL means no request", log.text(), "")


# ── Config validation (defect 5) ────────────────────────────────────────────

def base_env(**over):
    values = {
        "WATCHER_DB_DSN": DSN,
        "APP_BASE_URL": "https://www.careervine.app",
        "CRON_TRIGGER_SECRET": "shh",
    }
    values.update(over)
    return values


def load_config(**over):
    with environment(**base_env(**over)), captured_log() as log:
        try:
            return send_watcher.Config.from_env(), None, log.text()
        except SystemExit as err:
            return None, str(err), log.text()


def test_a_zero_poll_interval_is_clamped_instead_of_hammering_supabase():
    """POLL_SECONDS=0 is an unthrottled loop against both Supabase and Vercel."""
    cfg, err, log = load_config(POLL_SECONDS="0")
    check("no crash", err, None)
    check_true("clamped to something sane", cfg and cfg.poll_seconds >= 1)
    check_true("and said so", "POLL_SECONDS" in log)


def test_an_empty_value_means_unset_not_a_crash():
    """
    `POLL_SECONDS=` in an EnvironmentFile is an empty string, and float("")
    raised straight into systemd's 10s restart loop.
    """
    cfg, err, _ = load_config(POLL_SECONDS="", FLOOR_SECONDS="")
    check("no crash", err, None)
    check_true("defaults apply", cfg and cfg.poll_seconds == 15 and cfg.floor_seconds == 900)


def test_a_non_numeric_value_stops_startup_with_a_clear_message():
    cfg, err, _ = load_config(POLL_SECONDS="fifteen")
    check_true("startup refuses it", err is not None)
    check_true("and names the variable and the value",
               err and "POLL_SECONDS" in err and "fifteen" in err)


def test_a_stuck_backoff_floor_of_zero_cannot_disable_the_backoff():
    """STUCK_MIN_SECONDS=0 leaves `max(cooldown * 2, 0)` at zero forever: the
    exact runaway RouteState exists to prevent, re-enabled by config."""
    cfg, err, _ = load_config(STUCK_MIN_SECONDS="0", STUCK_MAX_SECONDS="0")
    check("no crash", err, None)
    check_true("backoff floor survives", cfg and cfg.stuck_min_seconds >= 1)
    check_true("ceiling is not below the floor",
               cfg and cfg.stuck_max_seconds >= cfg.stuck_min_seconds)


def test_a_base_url_without_a_scheme_stops_startup():
    """urllib raises `unknown url type` on every trigger otherwise, forever."""
    cfg, err, _ = load_config(APP_BASE_URL="www.careervine.app")
    check_true("startup refuses it", err is not None)
    check_true("and names the variable", err and "APP_BASE_URL" in err)


# ── Response bodies stay out of the journal (defect 8) ──────────────────────

SCHEDULED_BODY = (
    b'{"dueRows":2,"usersProcessed":1,"usersFailed":0,"sent":2,"errors":0,'
    b'"sweptFailed":0,"durationMs":812,"oldestDueScheduledAt":"2026-08-04T15:05:00.000Z",'
    b'"maxDelayMs":9000,"throughputEmailsPerMinute":147.8,"capacityStatus":"healthy",'
    b'"driver":"watcher"}'
)


def trigger_with(response=None, error=None):
    def fake_urlopen(req, timeout=None):
        if error is not None:
            raise error
        return response

    with patched(urllib.request, "urlopen", fake_urlopen), captured_log() as log:
        ok = send_watcher.trigger(CFG, "scheduled")
    return ok, log.text()


def test_a_send_time_from_the_response_never_reaches_the_journal():
    """
    The header of send_watcher.py claims this box cannot hold a send time. It
    logged 300 raw bytes of the cron response on every sweep, and that response
    carries `oldestDueScheduledAt`.
    """
    ok, text = trigger_with(FakeResponse(SCHEDULED_BODY))
    check("a 200 is a success", ok, True)
    check("no send time", "2026-08-04T15:05:00.000Z" in text, False)
    check("no string fields at all", "healthy" in text, False)
    check_true("the counters that matter survive", "sent=2" in text and "maxDelayMs=9000" in text)
    check_true("and the status", "200" in text)


def test_an_error_body_is_summarised_the_same_way():
    """An error body is exactly as persistent, and just as able to carry one."""
    err = urllib.error.HTTPError(
        "https://www.careervine.app/api/cron/send-scheduled-emails", 500,
        "Internal Server Error", {},
        io.BytesIO(b'{"error":"boom for 2026-08-04T15:05:00.000Z","sent":0}'),
    )
    ok, text = trigger_with(error=err)
    check("a 500 is a failure", ok, False)
    check("the status is loud", "500" in text, True)
    check("the body is not", "2026-08-04T15:05:00.000Z" in text, False)


def test_a_body_that_is_not_json_is_logged_as_a_size():
    """A Vercel error page is HTML, and truncating it to 300 chars is no defence."""
    page = b"<!DOCTYPE html><title>An error occurred</title><p>DEPLOYMENT_NOT_FOUND</p>"
    ok, text = trigger_with(FakeResponse(page, status=200))
    check("no markup in the journal", "DEPLOYMENT_NOT_FOUND" in text, False)
    check_true("but the size is recorded", str(len(page)) in text)


# ── Claims the code has to keep (defects 6, 8, 9) ───────────────────────────

def test_the_unit_stops_cleanly_even_during_the_slowest_cycle():
    """
    A cycle can sit in HTTP for two 90s triggers. systemd's default
    TimeoutStopUSec is 90s, so `systemctl stop` during one ends in SIGKILL --
    not the clean path Stopper's docstring describes.
    """
    unit = (HERE / "careervine-send-watcher.service").read_text()
    found = re.search(r"^TimeoutStopSec=(\d+)", unit, re.M)
    check_true("TimeoutStopSec is set", found)
    check_true("and covers two full HTTP timeouts",
               found and int(found.group(1)) >= 180)


def test_the_docs_do_not_claim_more_than_the_code_does():
    # Both claims wrap across lines in their files, so compare on one line.
    readme = " ".join((HERE / "README.md").read_text().split())
    header = " ".join((send_watcher.__doc__ or "").split())

    # Defect 8: this was false the whole time trigger() logged the raw body,
    # which carries oldestDueScheduledAt -- a send time, kept by journald.
    check("README drops the 'cannot read a send time' claim",
          "cannot read a recipient, subject, or send time" in readme, False)
    check_true("and says what it does keep instead", "counters" in readme)
    check_true("the module header names what it receives",
               "oldestDueScheduledAt" in header)

    # Defect 9: the apex fails through urllib, not undici. Verified locally: a
    # 307 on POST makes HTTPRedirectHandler raise HTTPError rather than follow.
    check("no undici symptom on a urllib client", "inscrutable" in readme, False)
    check_true("the real symptom is documented", "307" in readme)


TESTS = [
    test_idle_does_not_trigger_until_the_floor,
    test_new_work_triggers_immediately,
    test_backlog_that_will_not_drain_backs_off,
    test_progress_snaps_back_to_immediate,
    test_new_arrivals_during_a_stall_are_served,
    test_draining_to_zero_then_new_work_is_fast,
    test_a_poison_row_does_not_pin_the_progress_signal,
    test_the_oldest_instant_would_not_have_worked,
    test_a_fresh_start_does_not_sweep_a_box_that_has_uptime,
    test_the_floor_still_fires_once_its_interval_has_actually_elapsed,
    test_each_route_is_stamped_with_the_clock_at_its_own_trigger,
    test_a_watcher_whose_triggers_all_fail_stops_beating,
    test_the_heartbeat_tolerates_a_blip_and_returns_after_a_recovery,
    test_a_database_that_cannot_be_read_still_stops_the_heartbeat,
    test_dispatch_counts_failures_per_route,
    test_connect_bounds_a_socket_that_dies_while_idle,
    test_read_due_counts_bounds_the_query_itself,
    test_a_malformed_dsn_fails_fast_without_echoing_the_password,
    test_a_connection_failure_does_not_publish_the_dsn,
    test_the_heartbeat_token_is_not_logged_when_the_url_is_wrong,
    test_a_zero_poll_interval_is_clamped_instead_of_hammering_supabase,
    test_an_empty_value_means_unset_not_a_crash,
    test_a_non_numeric_value_stops_startup_with_a_clear_message,
    test_a_stuck_backoff_floor_of_zero_cannot_disable_the_backoff,
    test_a_base_url_without_a_scheme_stops_startup,
    test_a_send_time_from_the_response_never_reaches_the_journal,
    test_an_error_body_is_summarised_the_same_way,
    test_a_body_that_is_not_json_is_logged_as_a_size,
    test_the_unit_stops_cleanly_even_during_the_slowest_cycle,
    test_the_docs_do_not_claim_more_than_the_code_does,
]

for fn in TESTS:
    # A raise is a failure of that test, not of the run: one broken assumption
    # should not hide the state of the other 27. SystemExit has to be caught by
    # name because it is not an Exception, and it is the likeliest thing to come
    # out of here -- Config.from_env raises it by design.
    try:
        fn()
    except KeyboardInterrupt:
        raise
    except BaseException as err:  # noqa: BLE001
        failures.append(f"{fn.__name__}: raised {type(err).__name__}: {err}")

if failures:
    print(f"FAILED ({len(failures)} of {len(TESTS)} tests reported problems):")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print(f"all {len(TESTS)} send-watcher tests passed")

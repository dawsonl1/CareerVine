#!/usr/bin/env python3
"""
Pacing tests for the send watcher (CAR-215).

Run: python3 ops/send-watcher/test_send_watcher.py

Deliberately dependency-free plain asserts rather than pytest, and not wired
into CI, which is Node-only. The logic under test is small but it is the part
that decides how many times a day this thing calls Vercel, so it gets pinned.

The bug these exist for was found by running the daemon against a mock endpoint
that returned 200 without draining the queue: the watcher triggered on every
single cycle. In production that is not hypothetical, because "due" does not
mean "sendable" (daily cap reached, bounced address awaiting its NDR).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# psycopg2 is imported at module scope by the daemon but is not needed here.
try:
    import psycopg2  # noqa: F401
except ModuleNotFoundError:  # pragma: no cover
    import types
    sys.modules["psycopg2"] = types.ModuleType("psycopg2")

from send_watcher import Config, RouteState  # noqa: E402

CFG = Config(
    db_dsn="", app_base_url="", cron_secret="",
    poll_seconds=15, heartbeat_url=None,
    floor_seconds=900, stuck_min_seconds=60, stuck_max_seconds=900,
)

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def test_idle_does_not_trigger_until_the_floor():
    st, now = RouteState(), 1000.0
    go, _ = st.should_trigger(0, now, CFG, last_trigger=now)
    check("idle: no trigger", go, False)
    # Floor reached -> sweep anyway, so a row the counts cannot see still goes.
    go, reason = st.should_trigger(0, now + CFG.floor_seconds, CFG, last_trigger=now)
    check("idle: floor sweep", (go, reason), (True, "floor"))


def fire(st, count, now, last_trigger=0.0):
    """should_trigger + note_triggered, the way the main loop pairs them."""
    go, reason = st.should_trigger(count, now, CFG, last_trigger)
    if go:
        st.note_triggered(count, now, CFG, reason == "stuck")
    return go, reason


def test_new_work_triggers_immediately():
    st, now = RouteState(), 1000.0
    st.should_trigger(0, now, CFG, last_trigger=now)
    go, reason = st.should_trigger(1, now + 15, CFG, last_trigger=now)
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
    go, reason = st.should_trigger(2, now, CFG, last_trigger=now)
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
    go, reason = st.should_trigger(4, now, CFG, last_trigger=now)
    check("arrival breaks the gate", (go, reason), (True, "due"))
    check("arrival clears the penalty", st.cooldown, 0.0)


def test_draining_to_zero_then_new_work_is_fast():
    """The normal happy path, which is what the whole feature is for."""
    st, now = RouteState(), 1000.0
    fire(st, 1, now)
    now += CFG.poll_seconds
    st.should_trigger(0, now, CFG, last_trigger=now)  # drained
    check("drained resets", st.cooldown, 0.0)

    now += CFG.poll_seconds
    go, reason = st.should_trigger(3, now, CFG, last_trigger=now)
    check("next arrival is immediate", (go, reason), (True, "due"))


for fn in [
    test_idle_does_not_trigger_until_the_floor,
    test_new_work_triggers_immediately,
    test_backlog_that_will_not_drain_backs_off,
    test_progress_snaps_back_to_immediate,
    test_new_arrivals_during_a_stall_are_served,
    test_draining_to_zero_then_new_work_is_fast,
]:
    fn()

if failures:
    print("FAILED:")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print("all send-watcher pacing tests passed")

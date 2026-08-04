# CareerVine send watcher (CAR-215)

Makes scheduled emails and follow-up steps go out within seconds of the time the
user picked, instead of up to 15 minutes late.

## What it is

A ~200-line Python daemon on the Oracle A1 box (`ssh a1`). Every ~15s it asks
Postgres one question, `SELECT * FROM due_send_counts()`, and if the answer is
non-zero it POSTs the existing CareerVine cron route so the app sends.

**It is a clock, not a scheduler.** It never decides what to send and cannot
read a recipient, subject, or send time. All send logic stays in the Next app
where it is tested. If this box ever starts deciding *what* goes out, the logic
is split across two deploys and two release processes.

## Why not the obvious designs

| Approach | Why not |
| --- | --- |
| Poll QStash faster (`*/5`, `*/1`) | Free tier is 500 messages/day; `*/1` on both queues is 2,880. Buys 5 or 1 minute, never precision. |
| A1 curls the cron route every minute | ~2,880 Vercel invocations/day against a 4 Active-CPU-hr/mo Hobby budget already dominated by bundle-sync and calendar polling (CAR-106). Trades a QStash quota for a Vercel one. |
| QStash one-off per email (`Upstash-Not-Before`) | Works, but needs an arming pass, creation-time arming, a stored message id, cancel-on-edit, and horizon math, all to stay under a verified 7-day `maxDelay` and the 500/day ceiling. |
| Service role key on the box | Reads and writes everything. See "What it can see". |

Watching Postgres means the overwhelming majority of ticks (nothing due) cost
Vercel nothing, so triggers drop to roughly one per batch of real email: fewer
than the 96/day of empty polls this replaces. It frees Fluid budget rather than
spending it.

## What it can see

Exactly two integers. `due_send_counts()` is `SECURITY DEFINER` with a pinned
`search_path`; the `careervine_watcher` role holds `EXECUTE` on it and **no
table privileges at all**. Someone who takes this box gets two numbers and the
ability to make CareerVine run a sweep it was already going to run.

The counts mirror the crons' real due conditions, including the suspended-user
and inactive-sequence filters. Looser counts would make a permanently-skipped
row read as forever-due, and the watcher would poke Vercel every 15s forever.

## How it fails

Free-tier Oracle instances get reclaimed with no recovery path, and the
ampere-poller precedent shows they fail *quietly* (it provisioned a VM and
logged nothing). So failure is designed for, not hoped against:

1. **QStash still runs both routes hourly.** A dead watcher degrades delivery to
   hourly, never to zero. The existing CAS claim (CAR-134/CAR-179) already makes
   two concurrent drivers safe, so nothing double-sends.
2. **A BetterStack heartbeat emails Dawson when pings stop.** Off-box on
   purpose: a dead box cannot report its own death.
3. **The heartbeat only fires on a clean cycle**, so a watcher that is running
   but cannot reach Postgres still trips the alert.
4. **A `FLOOR_SECONDS` sweep** runs each route at least every 15 minutes even
   when the counts say nothing is due, so a bug in `due_send_counts()` cannot
   strand mail until the hourly net catches it.

## Layout

| Path | What |
| --- | --- |
| `/opt/careervine/send-watcher/send_watcher.py` | the daemon |
| `/etc/careervine/send-watcher.env` | secrets, `chmod 600`, root-owned, never in git |
| `/etc/systemd/system/careervine-send-watcher.service` | unit |

## Environment

```
WATCHER_DB_DSN=postgresql://careervine_watcher.<project-ref>:<pw>@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require
APP_BASE_URL=https://www.careervine.app
CRON_TRIGGER_SECRET=<matches Vercel production env>
HEARTBEAT_URL=<BetterStack heartbeat URL>
POLL_SECONDS=15
FLOOR_SECONDS=900
```

`APP_BASE_URL` must be the **www** host. The apex 307-redirects and undici
strips the `Authorization` header on the cross-origin hop (learned rule 29), so
the apex would fail as an inscrutable 401.

The A1 is **IPv4-only** and Supabase direct connections
(`db.<ref>.supabase.co`) are IPv6-only on the free tier, so the DSN must use the
**Supavisor pooler** on port 6543. Verified reachable from the box.

## Operating it

```bash
ssh a1 'systemctl status careervine-send-watcher'
```

```bash
ssh a1 'journalctl -u careervine-send-watcher -n 50 --no-pager'
```

```bash
ssh a1 'sudo systemctl restart careervine-send-watcher'
```

Deploy a code change:

```bash
scp ops/send-watcher/send_watcher.py a1:/tmp/ && ssh a1 'sudo install -m 755 /tmp/send_watcher.py /opt/careervine/send-watcher/send_watcher.py && sudo systemctl restart careervine-send-watcher'
```

## If the A1 is lost

Delivery keeps working on the hourly QStash safety net. To restore
second-level delivery on a new box: install `python3-psycopg2`, copy this
directory to `/opt/careervine/send-watcher/`, recreate
`/etc/careervine/send-watcher.env` from `~/.config/claude/secrets.zsh`, install
the unit, `systemctl enable --now careervine-send-watcher`. Nothing about the
watcher is stateful, and its IP does not matter because it only dials out.

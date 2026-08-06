#!/usr/bin/env bash
#
# CareerVine scheduled Gmail sync trigger (CAR-234).
#
#   sync-trigger.sh <endpoint-path> [allowed-local-hours-csv]
#
# Example:
#   sync-trigger.sh /api/cron/sync-gmail-recent
#   sync-trigger.sh /api/cron/sync-gmail-full 08,12,16
#
# ── Why the hour guard lives here and not in OnCalendar ────────────────────
#
# The full sweep should land at 08:00, 12:00 and 16:00 MOUNTAIN. This box runs
# systemd 249 with the system timezone on Etc/UTC. Inline timezones in
# OnCalendar ("08:00:00 America/Denver") need systemd 252+, so they are not
# available, and hardcoding the UTC equivalents silently drifts an hour at every
# DST transition — twice a year, in the wrong direction half the time.
#
# So the timer fires hourly and this guard decides. `date` resolves the zone
# from tzdata at call time, which is the one thing that is always right about
# DST, and the box's own timezone stays untouched (other services share it).
set -euo pipefail

ENDPOINT="${1:?usage: sync-trigger.sh <endpoint-path> [allowed-local-hours-csv]}"
ALLOWED_HOURS="${2:-}"
LOCAL_TZ="${CAREERVINE_LOCAL_TZ:-America/Denver}"

if [ -n "$ALLOWED_HOURS" ]; then
  now_hour="$(TZ="$LOCAL_TZ" date +%H)"
  case ",${ALLOWED_HOURS}," in
    *",${now_hour},"*) : ;;
    *)
      echo "skip: ${now_hour} ${LOCAL_TZ} not in {${ALLOWED_HOURS}}"
      exit 0
      ;;
  esac
fi

: "${APP_BASE_URL:?APP_BASE_URL missing (expected in /etc/careervine/send-watcher.env)}"
: "${CRON_TRIGGER_SECRET:?CRON_TRIGGER_SECRET missing (expected in /etc/careervine/send-watcher.env)}"

# --fail-with-body so a non-2xx is a unit failure AND the reason reaches the
# journal. --max-time above the route's own 60s maxDuration so a slow-but-
# working sweep is not killed by the client.
#
# NOTE: APP_BASE_URL must be the www host. The apex 307-redirects, and curl
# drops Authorization across that hop, so the bearer would silently vanish and
# every run would 401 (rule 29).
http_code="$(
  curl --silent --show-error --fail-with-body \
    --max-time 90 \
    --retry 2 --retry-delay 5 --retry-connrefused \
    -o /tmp/careervine-sync-last.json -w '%{http_code}' \
    -X POST "${APP_BASE_URL}${ENDPOINT}" \
    -H "Authorization: Bearer ${CRON_TRIGGER_SECRET}" \
    -H "Content-Length: 0"
)"

echo "${ENDPOINT} -> ${http_code}"
cat /tmp/careervine-sync-last.json 2>/dev/null || true
echo

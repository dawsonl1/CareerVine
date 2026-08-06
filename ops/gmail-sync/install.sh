#!/usr/bin/env bash
#
# Install the CareerVine scheduled Gmail sync timers on the A1 box (CAR-234).
# Idempotent: safe to re-run after editing any unit.
#
#   scp -r ops/gmail-sync a1:/tmp/ && ssh a1 'sudo bash /tmp/gmail-sync/install.sh'
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/careervine/gmail-sync
ENV_FILE=/etc/careervine/send-watcher.env

if [ ! -r "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE not readable. The send watcher owns it and both timers" >&2
  echo "       read CRON_TRIGGER_SECRET and APP_BASE_URL from it." >&2
  exit 1
fi

# Fail here rather than at 08:00 with a 401 nobody is watching.
for key in CRON_TRIGGER_SECRET APP_BASE_URL; do
  grep -q "^${key}=" "$ENV_FILE" || { echo "FATAL: ${key} missing from $ENV_FILE" >&2; exit 1; }
done

# rule 29: the apex 307-redirects and curl drops Authorization across the hop,
# so a non-www base URL would 401 on every single run, silently.
if grep -q '^APP_BASE_URL=https\?://careervine\.app' "$ENV_FILE"; then
  echo "FATAL: APP_BASE_URL points at the apex. Use https://www.careervine.app —" >&2
  echo "       the apex redirects and curl drops the Authorization header." >&2
  exit 1
fi

install -d -o ubuntu -g ubuntu "$DEST"
install -m 0755 -o ubuntu -g ubuntu "$SRC/sync-trigger.sh" "$DEST/sync-trigger.sh"

for unit in careervine-sync-full careervine-sync-recent; do
  install -m 0644 "$SRC/${unit}.service" "/etc/systemd/system/${unit}.service"
  install -m 0644 "$SRC/${unit}.timer" "/etc/systemd/system/${unit}.timer"
done

systemctl daemon-reload
systemctl enable --now careervine-sync-full.timer careervine-sync-recent.timer

echo
systemctl list-timers --no-pager 'careervine-sync-*'
echo
echo "Verify the hour guard without waiting for a real tick:"
echo "  sudo -u ubuntu env \$(grep -v '^#' $ENV_FILE | xargs) \\"
echo "    $DEST/sync-trigger.sh /api/cron/sync-gmail-full 08,12,16"
echo "  journalctl -u careervine-sync-recent.service -n 50 --no-pager"

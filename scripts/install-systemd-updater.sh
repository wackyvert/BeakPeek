#!/usr/bin/env sh
set -eu

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found. Run this on the Linux host that should run BeakPeek." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVICE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

SERVICE_NAME=${BEAKPEEK_SERVICE_NAME:-beakpeek}
UPDATE_SERVICE_NAME=${BEAKPEEK_UPDATE_SERVICE_NAME:-beakpeek-update}
SERVICE_USER=${BEAKPEEK_USER:-${SUDO_USER:-$(id -un)}}
GIT_REMOTE=${BEAKPEEK_GIT_REMOTE:-origin}
GIT_BRANCH=${BEAKPEEK_GIT_BRANCH:-main}
HEALTH_URL=${BEAKPEEK_HEALTH_URL:-http://localhost:8787/api/v1/summary}
NODE_BIN=${BEAKPEEK_NODE:-$(command -v node || true)}
NPM_BIN=${BEAKPEEK_NPM:-$(command -v npm || true)}
INTERVAL=${BEAKPEEK_UPDATE_INTERVAL:-15min}

if [ -z "$NODE_BIN" ]; then
  echo "node was not found. Install Node.js, or set BEAKPEEK_NODE=/absolute/path/to/node." >&2
  exit 1
fi

if [ -z "$NPM_BIN" ]; then
  echo "npm was not found. Install npm, or set BEAKPEEK_NPM=/absolute/path/to/npm." >&2
  exit 1
fi

case "$NODE_BIN" in /*) ;; *) echo "BEAKPEEK_NODE must be an absolute path, got: $NODE_BIN" >&2; exit 1 ;; esac
case "$NPM_BIN" in /*) ;; *) echo "BEAKPEEK_NPM must be an absolute path, got: $NPM_BIN" >&2; exit 1 ;; esac

if [ ! -x "$SERVICE_DIR/scripts/update-and-restart.sh" ]; then
  echo "Expected executable updater script at $SERVICE_DIR/scripts/update-and-restart.sh" >&2
  exit 1
fi

SERVICE_PATH="/etc/systemd/system/${UPDATE_SERVICE_NAME}.service"
TIMER_PATH="/etc/systemd/system/${UPDATE_SERVICE_NAME}.timer"
TMP_SERVICE=$(mktemp)
TMP_TIMER=$(mktemp)
trap 'rm -f "$TMP_SERVICE" "$TMP_TIMER"' EXIT

cat >"$TMP_SERVICE" <<EOF
[Unit]
Description=Fetch GitHub updates for BeakPeek and restart the app
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=BEAKPEEK_APP_DIR=${SERVICE_DIR}
Environment=BEAKPEEK_SERVICE_NAME=${SERVICE_NAME}
Environment=BEAKPEEK_RUN_USER=${SERVICE_USER}
Environment=BEAKPEEK_GIT_REMOTE=${GIT_REMOTE}
Environment=BEAKPEEK_GIT_BRANCH=${GIT_BRANCH}
Environment=BEAKPEEK_NODE=${NODE_BIN}
Environment=BEAKPEEK_NPM=${NPM_BIN}
Environment=BEAKPEEK_HEALTH_URL=${HEALTH_URL}
ExecStart=/bin/sh ${SERVICE_DIR}/scripts/update-and-restart.sh
EOF

cat >"$TMP_TIMER" <<EOF
[Unit]
Description=Periodically update BeakPeek from GitHub

[Timer]
OnBootSec=5min
OnUnitActiveSec=${INTERVAL}
RandomizedDelaySec=2min
Persistent=true
Unit=${UPDATE_SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

sudo install -m 0644 "$TMP_SERVICE" "$SERVICE_PATH"
sudo install -m 0644 "$TMP_TIMER" "$TIMER_PATH"
sudo systemctl daemon-reload
sudo systemctl enable --now "${UPDATE_SERVICE_NAME}.timer"

echo "Installed and started ${UPDATE_SERVICE_NAME}.timer"
echo "Run once: sudo systemctl start ${UPDATE_SERVICE_NAME}.service"
echo "Timer:    systemctl list-timers ${UPDATE_SERVICE_NAME}.timer"
echo "Logs:     journalctl -u ${UPDATE_SERVICE_NAME}.service -f"

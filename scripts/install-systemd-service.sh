#!/usr/bin/env sh
set -eu

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found. Run this on the Linux host that should run BeakPeek." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVICE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

DEFAULT_USER=${SUDO_USER:-$(id -un)}
SERVICE_NAME=${BEAKPEEK_SERVICE_NAME:-beakpeek}
SERVICE_USER=${BEAKPEEK_USER:-$DEFAULT_USER}
SERVICE_GROUP=${BEAKPEEK_GROUP:-$(id -gn "$SERVICE_USER")}
NODE_BIN=${BEAKPEEK_NODE:-$(command -v node || true)}

if [ -z "$NODE_BIN" ]; then
  echo "node was not found. Install Node.js >=22.5, or set BEAKPEEK_NODE=/absolute/path/to/node." >&2
  exit 1
fi

case "$NODE_BIN" in
  /*) ;;
  *)
    echo "BEAKPEEK_NODE must be an absolute path, got: $NODE_BIN" >&2
    exit 1
    ;;
esac

if [ ! -f "$SERVICE_DIR/src/main.mjs" ]; then
  echo "Could not find $SERVICE_DIR/src/main.mjs" >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
TMP_UNIT=$(mktemp)
trap 'rm -f "$TMP_UNIT"' EXIT

cat >"$TMP_UNIT" <<EOF
[Unit]
Description=BeakPeek feeder intelligence service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${SERVICE_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${SERVICE_DIR}/.env
ExecStart=${NODE_BIN} ${SERVICE_DIR}/src/main.mjs
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"

echo "Installed and started ${SERVICE_NAME}.service"
echo "Status:  systemctl status ${SERVICE_NAME}.service"
echo "Logs:    journalctl -u ${SERVICE_NAME}.service -f"

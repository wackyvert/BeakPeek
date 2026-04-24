#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
if [ -d "$ROOT_DIR/venv" ]; then
  VENV_DIR="$ROOT_DIR/venv"
else
  VENV_DIR="$ROOT_DIR/.venv"
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/requirements.txt"

echo "Python deps installed in $VENV_DIR"

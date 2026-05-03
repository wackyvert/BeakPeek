#!/usr/bin/env sh
set -eu

APP_DIR=${BEAKPEEK_APP_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
SERVICE_NAME=${BEAKPEEK_SERVICE_NAME:-beakpeek}
REMOTE=${BEAKPEEK_GIT_REMOTE:-origin}
BRANCH=${BEAKPEEK_GIT_BRANCH:-main}
RUN_USER=${BEAKPEEK_RUN_USER:-${SUDO_USER:-$(id -un)}}
HEALTH_URL=${BEAKPEEK_HEALTH_URL:-http://localhost:8787/api/v1/summary}

NODE_BIN=${BEAKPEEK_NODE:-$(command -v node || true)}
NPM_BIN=${BEAKPEEK_NPM:-$(command -v npm || true)}
if [ -n "$NODE_BIN" ]; then
  PATH="$(dirname "$NODE_BIN"):$PATH"
fi
if [ -n "$NPM_BIN" ]; then
  PATH="$(dirname "$NPM_BIN"):$PATH"
fi
export PATH

quote_shell() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

APP_DIR_Q=$(quote_shell "$APP_DIR")
PATH_Q=$(quote_shell "$PATH")

run_in_app_dir() {
  command=$1
  if [ "$(id -un)" = "$RUN_USER" ]; then
    sh -c "cd $APP_DIR_Q && $command"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- sh -c "export PATH=$PATH_Q; cd $APP_DIR_Q && $command"
  else
    sudo -H -u "$RUN_USER" env PATH="$PATH" sh -c "cd $APP_DIR_Q && $command"
  fi
}

restart_service() {
  if [ "$(id -u)" = "0" ]; then
    systemctl restart "${SERVICE_NAME}.service"
  else
    sudo systemctl restart "${SERVICE_NAME}.service"
  fi
}

run_in_app_dir "git rev-parse --is-inside-work-tree >/dev/null"
run_in_app_dir "git update-index -q --refresh"

if ! run_in_app_dir "git diff-index --quiet HEAD --"; then
  echo "Tracked local changes are present in $APP_DIR; skipping automatic update."
  exit 0
fi

BEFORE=$(run_in_app_dir "git rev-parse HEAD")
run_in_app_dir "git fetch --prune $REMOTE $BRANCH"
TARGET=$(run_in_app_dir "git rev-parse $REMOTE/$BRANCH")

if [ "$BEFORE" = "$TARGET" ]; then
  echo "BeakPeek is already up to date at $BEFORE."
  exit 0
fi

if ! run_in_app_dir "git merge-base --is-ancestor HEAD $REMOTE/$BRANCH"; then
  echo "Remote $REMOTE/$BRANCH is not a fast-forward from $BEFORE; skipping automatic update." >&2
  exit 1
fi

CHANGED_FILES=$(mktemp)
trap 'rm -f "$CHANGED_FILES"' EXIT
run_in_app_dir "git diff --name-only HEAD $REMOTE/$BRANCH" >"$CHANGED_FILES"
run_in_app_dir "git merge --ff-only $REMOTE/$BRANCH"

if grep -Eq '(^package.json$|^package-lock.json$|^npm-shrinkwrap.json$)' "$CHANGED_FILES"; then
  if run_in_app_dir "test -f package-lock.json"; then
    run_in_app_dir "npm ci --omit=dev || npm install --omit=dev"
  else
    run_in_app_dir "npm install --omit=dev"
  fi
fi

if grep -Eq '(^requirements.txt$|^scripts/setup-python\.sh$)' "$CHANGED_FILES"; then
  run_in_app_dir "npm run setup:python"
fi

restart_service

if command -v curl >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "$HEALTH_URL" >/dev/null; then
      echo "Updated BeakPeek from $BEFORE to $TARGET and restarted ${SERVICE_NAME}.service."
      exit 0
    fi
    sleep 1
  done
  echo "Updated BeakPeek from $BEFORE to $TARGET, but health check failed: $HEALTH_URL" >&2
  exit 1
fi

echo "Updated BeakPeek from $BEFORE to $TARGET and restarted ${SERVICE_NAME}.service."

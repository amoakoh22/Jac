#!/usr/bin/env bash
# Jac Syndicate - Local 24/7 Supervisor (setsid + PID lockfile + restart loop)
# Keeps syndicate/autonomous_syndicate_daemon.js alive across transient crashes.
# Start with: setsid bash syndicate/run_daemon_supervisor.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/runtime/jac_supervisor.pid"
LOG_DIR="$ROOT_DIR/runtime/logs"
SUP_LOG="$LOG_DIR/supervisor.log"

mkdir -p "$LOG_DIR"

# Re-exec inside a new session via setsid if not already detached when --detach is passed
if [[ "${1:-}" == "--detach" ]]; then
  shift
  exec setsid "$0" "$@" >>"$SUP_LOG" 2>&1 < /dev/null &
  exit 0
fi

# PID lockfile check (prevent duplicate supervisors)
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Already running (PID $OLD_PID). Exiting." | tee -a "$SUP_LOG"
    exit 0
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Removing stale PID file ($OLD_PID)." | tee -a "$SUP_LOG"
    rm -f "$PID_FILE"
  fi
fi

echo "$$" > "$PID_FILE"
trap 'rm -f "$PID_FILE"; echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Stopped (PID $$)." | tee -a "$SUP_LOG"' EXIT INT TERM

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Started (PID $$, PGID $(ps -o pgid= -p $$ | tr -d " "))." | tee -a "$SUP_LOG"

cd "$ROOT_DIR"
RESTARTS=0
while true; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Launching autonomous_syndicate_daemon.js (restart #$RESTARTS)..." | tee -a "$SUP_LOG"
  set +e
  node syndicate/autonomous_syndicate_daemon.js >>"$SUP_LOG" 2>&1
  EXIT_CODE=$?
  set -e
  RESTARTS=$((RESTARTS + 1))
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [Supervisor] Daemon exited with code $EXIT_CODE. Restarting in 15s..." | tee -a "$SUP_LOG"
  sleep 15
done

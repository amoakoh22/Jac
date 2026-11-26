#!/usr/bin/env bash
set -euo pipefail

TMP_DIR="/tmp/jac_cold_start_verify_$$"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[ColdStart] Cloning origin/main into $TMP_DIR (zero local runtime/)..."
git clone --depth 1 https://github.com/amoakoh22/Jac.git "$TMP_DIR" >/dev/null 2>&1
cd "$TMP_DIR"

echo "[ColdStart] Checking SQLite integrity..."
sqlite3 data/syndicate_ledger.sqlite "PRAGMA integrity_check;" | grep -qx "ok"

echo "[ColdStart] Installing npm dependencies (clean)..."
npm ci --silent >/dev/null

echo "[ColdStart] Running Node & Python test suites..."
npm test >/dev/null
python3 -m unittest discover -s test >/dev/null

echo "[ColdStart] Running WakeupGate, Orchestrator dry-run & KPI Terminal render..."
python3 syndicate/check_wakeup_gate.py --event schedule
node syndicate/autonomous_orchestrator.js --dry-run
python3 syndicate/render_syndicate_terminal.py >/dev/null

echo "[ColdStart] PASS — 100% reproducible from fresh clone (zero VM state dependency)."

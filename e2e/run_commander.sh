#!/usr/bin/env bash
# One-command end-to-end check for the commander role's console UI: starts a real
# backend (inkbox_claude.console routes from the commander backend working copy,
# bound to this box's Tailscale address) and the real frontend (the console-commander
# working copy's static/ + index.html, unmodified) on their own ports, runs the
# headless Playwright commander checks, then shuts everything down.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/scratch/pw-venv/bin/python"
export E2E_BACKEND_REPO="$HOME/blatbot/worktrees/commander"

BACKEND_PORT=18796
FRONTEND_PORT=18797

TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [[ -z "$TAILNET_IP" ]]; then
  echo "FAIL: no Tailscale IPv4 address on this machine." >&2
  exit 1
fi

TMPDIR_RUN="$(mktemp -d /tmp/blatbot-commander-e2e.XXXXXX)"
DB_PATH="$TMPDIR_RUN/console.db"
BACKEND_LOG="$TMPDIR_RUN/backend.log"
FRONTEND_LOG="$TMPDIR_RUN/frontend.log"

FRONTEND_ORIGIN="http://127.0.0.1:${FRONTEND_PORT}"
BACKEND_TAILNET_BASE="http://${TAILNET_IP}:${BACKEND_PORT}"
BACKEND_LOOPBACK_BASE="http://127.0.0.1:${BACKEND_PORT}"

cleanup() {
  [[ -n "${BACKEND_PID:-}" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting backend on 0.0.0.0:${BACKEND_PORT} (tailnet ${TAILNET_IP}), origins=${FRONTEND_ORIGIN}"
"$VENV" "$HERE/backend_launcher.py" 0.0.0.0 "$BACKEND_PORT" "$FRONTEND_ORIGIN" "$DB_PATH" \
  > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Starting frontend on 127.0.0.1:${FRONTEND_PORT} -> api ${BACKEND_TAILNET_BASE}/console/api"
"$VENV" "$HERE/frontend_server.py" 127.0.0.1 "$FRONTEND_PORT" \
  "${BACKEND_TAILNET_BASE}/console/api" "${BACKEND_TAILNET_BASE}/console/events" \
  > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

for i in $(seq 1 50); do
  grep -q READY "$BACKEND_LOG" 2>/dev/null && grep -q READY "$FRONTEND_LOG" 2>/dev/null && break
  sleep 0.2
done
if ! grep -q READY "$BACKEND_LOG" 2>/dev/null; then
  echo "FAIL: backend never became ready"; cat "$BACKEND_LOG" >&2; exit 1
fi
if ! grep -q READY "$FRONTEND_LOG" 2>/dev/null; then
  echo "FAIL: frontend never became ready"; cat "$FRONTEND_LOG" >&2; exit 1
fi

set +e
"$VENV" "$HERE/check_commander.py" "$FRONTEND_ORIGIN" "$BACKEND_TAILNET_BASE" "$BACKEND_LOOPBACK_BASE"
STATUS=$?
set -e

echo "--- backend log tail ---"
tail -n 20 "$BACKEND_LOG"
echo "--- frontend log tail ---"
tail -n 20 "$FRONTEND_LOG"

exit "$STATUS"

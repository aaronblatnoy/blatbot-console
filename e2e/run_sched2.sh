#!/usr/bin/env bash
# One-command end-to-end check for the Schedules page against the stub API in
# stub_schedules_backend.py (the real backend doesn't exist yet -- see SPEC.md).
# Starts the stub backend and the real frontend (this repo's index.html + static/,
# unmodified) on their own ports, runs the headless Playwright checks, then shuts
# everything down. Exits non-zero on any check failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${E2E_PYTHON:-$HOME/scratch/pw-venv/bin/python}"

BACKEND_PORT="${E2E_BACKEND_PORT:-18810}"
FRONTEND_PORT="${E2E_FRONTEND_PORT:-18811}"

TMPDIR_RUN="$(mktemp -d /tmp/blatbot-sched2-e2e.XXXXXX)"
BACKEND_LOG="$TMPDIR_RUN/backend.log"
FRONTEND_LOG="$TMPDIR_RUN/frontend.log"

FRONTEND_ORIGIN="http://127.0.0.1:${FRONTEND_PORT}"
BACKEND_BASE="http://127.0.0.1:${BACKEND_PORT}"

cleanup() {
  [[ -n "${BACKEND_PID:-}" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting stub backend on 127.0.0.1:${BACKEND_PORT}"
"$VENV" "$HERE/stub_schedules_backend.py" 127.0.0.1 "$BACKEND_PORT" > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Starting frontend on 127.0.0.1:${FRONTEND_PORT} -> api ${BACKEND_BASE}/console/api"
"$VENV" "$HERE/frontend_server.py" 127.0.0.1 "$FRONTEND_PORT" \
  "${BACKEND_BASE}/console/api" "${BACKEND_BASE}/console/events" \
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
"$VENV" "$HERE/check_sched2.py" "$FRONTEND_ORIGIN" "$BACKEND_BASE"
STATUS=$?
set -e

echo "--- backend log tail ---"
tail -n 20 "$BACKEND_LOG"
echo "--- frontend log tail ---"
tail -n 20 "$FRONTEND_LOG"

exit "$STATUS"

#!/usr/bin/env bash
# End-to-end check of the Schedules page against the REAL backend in
# ~/blatbot/worktrees/sched2 (not the stub): starts that backend's actual
# inkbox_claude.console routes, seeded with made-up schedules through the real
# Store + ScheduleService, bound to this box's Tailscale address (exercising the
# real tailnet_gate), and this repo's real frontend. Never touches ~/blatbot/.env,
# the live database, or the live ports (8771, 8793).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The backend launcher runs the real inkbox_claude package, which needs the app's
# own venv; the frontend server and the Playwright checks need the e2e venv instead
# (it has playwright, the app venv does not). Two separate interpreters on purpose.
BACKEND_VENV="${E2E_BACKEND_PYTHON:-$HOME/blatbot/app/.venv/bin/python}"
E2E_VENV="${E2E_PYTHON:-$HOME/scratch/pw-venv/bin/python}"
export E2E_SCHED_BACKEND_REPO="${E2E_SCHED_BACKEND_REPO:-$HOME/blatbot/worktrees/sched2}"

BACKEND_PORT="${E2E_BACKEND_PORT:-18825}"
FRONTEND_PORT="${E2E_FRONTEND_PORT:-18826}"

TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [[ -z "$TAILNET_IP" ]]; then
  echo "FAIL: no Tailscale IPv4 address on this machine (tailscale ip -4 returned nothing)." >&2
  echo "Refusing to weaken the tailnet gate by binding to 127.0.0.1 instead." >&2
  exit 1
fi

TMPDIR_RUN="$(mktemp -d /tmp/blatbot-sched2-real-e2e.XXXXXX)"
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

echo "Starting REAL schedule backend on 0.0.0.0:${BACKEND_PORT} (tailnet ${TAILNET_IP}), origins=${FRONTEND_ORIGIN}"
"$BACKEND_VENV" "$HERE/schedule_backend_launcher.py" 0.0.0.0 "$BACKEND_PORT" "$FRONTEND_ORIGIN" "$DB_PATH" \
  > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Starting frontend on 127.0.0.1:${FRONTEND_PORT} -> api ${BACKEND_TAILNET_BASE}/console/api"
"$E2E_VENV" "$HERE/frontend_server.py" 127.0.0.1 "$FRONTEND_PORT" \
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
timeout 180 "$E2E_VENV" "$HERE/check_sched2_real.py" "$FRONTEND_ORIGIN" "$BACKEND_TAILNET_BASE" "$BACKEND_LOOPBACK_BASE"
STATUS=$?
set -e

echo "--- backend log tail ---"
tail -n 30 "$BACKEND_LOG"
echo "--- frontend log tail ---"
tail -n 20 "$FRONTEND_LOG"

exit "$STATUS"

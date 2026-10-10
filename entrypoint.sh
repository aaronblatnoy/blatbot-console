#!/bin/sh
# Writes static/config.js from CONSOLE_API_BASE / CONSOLE_EVENTS_URL at container
# start, then runs the stdlib static server bound to 0.0.0.0 inside the container
# (the host-level exposure -- which interface the port is published on outside the
# container -- is controlled by the Coolify/docker port mapping, not here).
#
# The tracked static/config.js in this repo (the local-dev default pointing at the
# stub API) is NOT edited by this script; this only rewrites the copy inside the
# running container's filesystem.
set -eu

API_BASE="${CONSOLE_API_BASE:?CONSOLE_API_BASE must be set}"
EVENTS_URL="${CONSOLE_EVENTS_URL:?CONSOLE_EVENTS_URL must be set}"

cat > /app/static/config.js <<EOF
// Generated at container start by entrypoint.sh from CONSOLE_API_BASE /
// CONSOLE_EVENTS_URL. Do not edit by hand -- it is overwritten on every restart.
window.CONSOLE_CONFIG = {
  apiBase: "${API_BASE}",
  eventsUrl: "${EVENTS_URL}",
};
EOF

export BIND_HOST="0.0.0.0"
exec python3 /app/serve.py "${PORT:-8793}"

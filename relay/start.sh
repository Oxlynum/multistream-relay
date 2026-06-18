#!/usr/bin/env bash
# Entrypoint: launch MediaMTX (ingest) and the control-panel/relay (egress).
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${RELAY_PASSWORD:-}" ]]; then
  echo "FATAL: set RELAY_PASSWORD (the control panel refuses to run unprotected)." >&2
  exit 1
fi

# First-run: seed config from the example if none exists.
if [[ ! -f config.json ]]; then
  echo "No config.json found; seeding from config.example.json"
  cp config.example.json config.json
fi

# Make the OBS start/stop hook executable (used by MediaMTX runOnReady).
chmod +x hook.sh 2>/dev/null || true

# 1) MediaMTX ingest server (background)
echo "Starting MediaMTX ingest..."
mediamtx ./mediamtx.yml &
MEDIA_PID=$!

# Give MediaMTX a moment to bind its ports.
sleep 2

# Generate a self-signed TLS cert on first run. Encrypts traffic against passive
# eavesdropping without needing a domain name or Let's Encrypt.
if [[ ! -f relay.crt ]] || [[ ! -f relay.key ]]; then
    echo "Generating self-signed TLS certificate..."
    openssl req -x509 -newkey rsa:2048 -keyout relay.key -out relay.crt \
        -days 3650 -nodes -subj "/CN=relay" 2>/dev/null
    echo "TLS certificate generated (relay.crt / relay.key)"
fi

# Print OBS setup info so the user can copy-paste without hunting for the token.
EXT_IP=$(curl -sf --max-time 4 https://api.ipify.org 2>/dev/null || echo '<pod-external-ip>')
DOCK_TOKEN="${RELAY_TOKEN:-${RELAY_PASSWORD}}"
echo ""
echo "==> OBS Setup"
echo "    Stream URL   (Settings → Stream → Custom RTMP):"
echo "      rtmp://${EXT_IP}:1935/live"
echo "    Control Dock (Docks → Custom Browser Dock):"
echo "      https://${EXT_IP}:8080/?token=${DOCK_TOKEN}"
echo ""

# 2) Control panel + relay supervisor (foreground)
echo "Starting control panel on :8080 (HTTPS)..."
exec uvicorn app:app --host 0.0.0.0 --port 8080 \
    --ssl-keyfile relay.key --ssl-certfile relay.crt

# If uvicorn exits, take MediaMTX down too.
kill "$MEDIA_PID" 2>/dev/null || true

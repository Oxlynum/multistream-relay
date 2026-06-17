#!/usr/bin/env bash
# Called by MediaMTX when OBS starts/stops publishing.
#   hook.sh start   -> turn the transcoder/multistreamer ON
#   hook.sh stop    -> turn it OFF (saves GPU/data when the stream ends)
#
# Talks to the local control panel API on 127.0.0.1:8080. Uses RELAY_TOKEN if
# set, otherwise falls back to RELAY_PASSWORD (the API accepts either as ?token).

ACTION="${1:-}"
AUTH="${RELAY_TOKEN:-${RELAY_PASSWORD:-}}"

python3 - "$ACTION" "$AUTH" <<'PY'
import sys, json, urllib.request, urllib.parse

action, auth = sys.argv[1], sys.argv[2]
if action not in ("start", "stop"):
    print(f"hook: ignoring unknown action {action!r}")
    sys.exit(0)

url = "http://127.0.0.1:8080/api/control"
if auth:
    url += "?token=" + urllib.parse.quote(auth)

# A stop from OBS is graceful: the relay waits out a grace period so a brief
# reconnect cancels it. (The panel's Stop button stops immediately instead.)
payload = {"action": action, "grace": action == "stop"}
req = urllib.request.Request(
    url,
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"hook: relay {action} -> {r.status}")
except Exception as e:
    print(f"hook: relay {action} failed: {e}")
PY

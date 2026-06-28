#!/usr/bin/env bash
# Called by MediaMTX when OBS starts/stops publishing to the pod.
#   hook.sh start   -> OBS connected; wake agent.py immediately via SIGUSR1
#   hook.sh stop    -> OBS disconnected; wake agent.py to start grace-terminate timer
#
# The flag file is the state signal; SIGUSR1 is just the wake-up so agent.py
# doesn't have to wait out its 10-second poll interval before reacting.

ACTION="${1:-}"
OBS_FLAG="/tmp/obs_connected"
AGENT_PID_FILE="/tmp/agent.pid"

# MediaMTX exports MTX_PATH (the published path = the tenant's ingest key) into the
# hook environment. The VPS hub role reads a PER-TENANT flag so one tenant's OBS
# disconnect can't tear down the others; the all-in-one role reads the single global
# flag (unchanged). We write BOTH — the per-path flag is harmless/unused in all-in-one.
MTX_PATH_VAL="${MTX_PATH:-}"
# Sanitize to a safe filename fragment (real ingest keys are hex; this is belt-and-suspenders).
PER_PATH_FLAG=""
if [ -n "$MTX_PATH_VAL" ]; then
    SAFE_PATH="$(printf '%s' "$MTX_PATH_VAL" | tr -cd 'A-Za-z0-9_-')"
    [ -n "$SAFE_PATH" ] && PER_PATH_FLAG="/tmp/obs_connected.${SAFE_PATH}"
fi

_wake_agent() {
    if [ -f "$AGENT_PID_FILE" ]; then
        kill -USR1 "$(cat "$AGENT_PID_FILE")" 2>/dev/null || true
    fi
}

case "$ACTION" in
  start)
    touch "$OBS_FLAG"
    [ -n "$PER_PATH_FLAG" ] && touch "$PER_PATH_FLAG"
    _wake_agent
    echo "hook: OBS connected (path='${MTX_PATH_VAL}') → agent woken"
    ;;
  stop)
    rm -f "$OBS_FLAG"
    [ -n "$PER_PATH_FLAG" ] && rm -f "$PER_PATH_FLAG"
    _wake_agent
    echo "hook: OBS disconnected (path='${MTX_PATH_VAL}') → agent woken"
    ;;
  *)
    echo "hook: ignoring unknown action '${ACTION}'"
    ;;
esac

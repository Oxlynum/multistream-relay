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

_wake_agent() {
    if [ -f "$AGENT_PID_FILE" ]; then
        kill -USR1 "$(cat "$AGENT_PID_FILE")" 2>/dev/null || true
    fi
}

case "$ACTION" in
  start)
    touch "$OBS_FLAG"
    _wake_agent
    echo "hook: OBS connected → agent woken, encoders will start immediately"
    ;;
  stop)
    rm -f "$OBS_FLAG"
    _wake_agent
    echo "hook: OBS disconnected → agent woken, grace-terminate timer starting"
    ;;
  *)
    echo "hook: ignoring unknown action '${ACTION}'"
    ;;
esac

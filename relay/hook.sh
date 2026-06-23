#!/usr/bin/env bash
# Called by MediaMTX when OBS starts/stops publishing to the pod.
#   hook.sh start   -> OBS connected; signal agent.py to start encoders now
#   hook.sh stop    -> OBS disconnected; signal agent.py to schedule a grace stop
#
# Uses a flag file (/tmp/obs_connected) instead of calling app.py's /api/control.
# This avoids the dual-supervisor problem: agent.py owns the Supervisor instance
# that actually runs FFmpeg; app.py has a separate one that never got a config.

ACTION="${1:-}"
OBS_FLAG="/tmp/obs_connected"

case "$ACTION" in
  start)
    touch "$OBS_FLAG"
    echo "hook: OBS connected → flag set (agent will start encoders on next poll)"
    ;;
  stop)
    rm -f "$OBS_FLAG"
    echo "hook: OBS disconnected → flag cleared (agent will schedule grace stop)"
    ;;
  *)
    echo "hook: ignoring unknown action '${ACTION}'"
    ;;
esac

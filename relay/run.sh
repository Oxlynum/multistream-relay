#!/usr/bin/env bash
# One-command launcher. Stores your panel password + dock token so you never
# have to retype them. Edit the two values below if you ever change them.
cd "$(dirname "$0")"

export RELAY_PASSWORD='change-me'
export RELAY_TOKEN='change-me'
export RELAY_STOP_GRACE=20      # seconds to wait before stopping on an OBS drop

./start.sh

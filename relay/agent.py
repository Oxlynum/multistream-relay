"""
agent.py — on-boot entrypoint for the SlimCast relay Docker container.

Replaces run.sh / start.sh. Responsibilities:
  1. Read SLIMCAST_API_KEY from environment (injected by RunPod at pod creation).
  2. POST /api/agent/pair → register IP, receive initial config.
  3. Start MediaMTX subprocess (ingest + SRT loopback).
  4. Start uvicorn (FastAPI control panel, debug only).
  5. Poll /api/agent/config every 10s → store config; apply it once OBS connects.
  6. Watch /tmp/obs_connected (written by hook.sh) to know when OBS connects/drops.
     On connect  → immediately call sup.apply() so FFmpeg starts with a fresh retry
                   rather than waiting out whatever backoff the runners are in.
     On disconnect → call sup.schedule_stop() for the grace period.
  7. POST /api/agent/status → heartbeat with live stream state.
  8. Handle stop commands in heartbeat response.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error

# Per-pod secret ingest path (set by provision via SLIMCAST_INGEST_KEY). MediaMTX
# accepts only this path and republishes it over the SRT loopback under the same
# name, so the encoders must pull from it. RELAY_SOURCE has to be set BEFORE
# importing supervisor (it reads it at import time). Defaults to "live" locally.
INGEST_KEY = (os.environ.get("SLIMCAST_INGEST_KEY", "live").strip() or "live")
os.environ.setdefault("RELAY_SOURCE", f"srt://127.0.0.1:8890?streamid=read:{INGEST_KEY}")

from supervisor import Supervisor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(message)s")
log = logging.getLogger("agent")

API_KEY    = os.environ.get("SLIMCAST_API_KEY", "")
VERCEL_URL = os.environ.get("SLIMCAST_VERCEL_URL", "https://slimcast-oxlynum.vercel.app")
POLL_INTERVAL = int(os.environ.get("AGENT_POLL_INTERVAL", "10"))
MEDIAMTX_CONFIG = os.environ.get("MEDIAMTX_CONFIG", "mediamtx.yml")

# Flag file written by hook.sh when OBS publishes to MediaMTX (runOnReady).
# Cleared when OBS drops (runOnNotReady). Agent uses this to start/stop the
# supervisor in sync with OBS instead of starting at pod boot.
OBS_FLAG = "/tmp/obs_connected"

# ── Safety watchdogs ──────────────────────────────────────────────────────────
HEARTBEAT_FAIL_LIMIT = int(os.environ.get("AGENT_HB_FAIL_LIMIT", "6"))   # ~60s
IDLE_LIMIT_S = int(os.environ.get("AGENT_IDLE_LIMIT_S", str(5 * 60)))

if not API_KEY:
    log.error("SLIMCAST_API_KEY is not set — cannot authenticate with Vercel.")
    sys.exit(1)


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }


def _get_external_ip() -> str:
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=5) as r:
            return r.read().decode().strip()
    except Exception:
        return ""


def _api(method: str, path: str, body: dict | None = None, timeout: int = 10) -> dict | None:
    url = f"{VERCEL_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        log.warning("API %s %s → %d", method, path, e.code)
        return None
    except Exception as exc:
        log.warning("API %s %s error: %s", method, path, exc)
        return None


def _render_mediamtx_config() -> str:
    """Substitute the per-pod ingest path into the MediaMTX config template."""
    with open(MEDIAMTX_CONFIG) as f:
        cfg = f.read()
    cfg = cfg.replace("__INGEST_PATH__", INGEST_KEY)
    runtime_path = "/tmp/mediamtx.runtime.yml"
    with open(runtime_path, "w") as f:
        f.write(cfg)
    return runtime_path


def start_mediamtx() -> subprocess.Popen:
    config = _render_mediamtx_config()
    log.info("Starting MediaMTX (ingest path configured)…")
    proc = subprocess.Popen(["mediamtx", config])
    time.sleep(2)
    if proc.poll() is not None:
        log.error("MediaMTX exited immediately (code %s)", proc.returncode)
        sys.exit(1)
    log.info("MediaMTX running (pid %d)", proc.pid)
    return proc


def start_uvicorn() -> subprocess.Popen:
    log.info("Starting uvicorn control panel on :8080…")
    return subprocess.Popen([
        "uvicorn", "app:app",
        "--host", "0.0.0.0",
        "--port", "8080",
    ])


def build_outputs(config: dict) -> list[dict]:
    return config.get("outputs", [])


def main() -> None:
    ip = _get_external_ip()
    log.info("External IP: %s", ip or "(unknown)")

    log.info("Pairing with %s…", VERCEL_URL)
    pair_resp = {}
    for attempt in range(10):
        pair_resp = _api("POST", "/api/agent/pair", {"ip_address": ip}) or {}
        if pair_resp.get("ok"):
            break
        log.warning("Pair attempt %d failed, retrying in 5s…", attempt + 1)
        time.sleep(5)
    else:
        log.error("Failed to pair with Vercel after 10 attempts. Exiting.")
        sys.exit(1)

    log.info("Paired successfully.")

    mediamtx_proc = start_mediamtx()
    uvicorn_proc = start_uvicorn()

    sup = Supervisor()

    # Store the latest config. We apply it when OBS connects, not at pod boot.
    # Reason: starting FFmpeg before OBS publishes means it immediately fails the
    # SRT loopback read and enters exponential backoff. If OBS connects while
    # FFmpeg is in a 30s backoff window, it won't pick up the stream until the
    # backoff expires — and the OBS plugin's 90s watchdog may fire first.
    # Instead: watch the flag file hook.sh writes and start immediately on connect.
    last_known_config: dict = pair_resp.get("config", {})
    last_config_hash = json.dumps(
        {"outputs": last_known_config.get("outputs", []),
         "crop": last_known_config.get("crop", {})},
        sort_keys=True,
    )

    # Handle the case where the agent restarts mid-stream (OBS already connected).
    prev_obs_connected = os.path.exists(OBS_FLAG)
    if prev_obs_connected:
        log.info("OBS already connected on startup — applying config immediately.")
        if last_known_config:
            sup.apply(last_known_config)
    else:
        log.info("Waiting for OBS to connect (watching %s).", OBS_FLAG)

    def shutdown(sig: int, _frame: object) -> None:
        log.info("Received signal %d — shutting down…", sig)
        sup.stop_all()
        mediamtx_proc.terminate()
        uvicorn_proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    streaming = False
    start_time = time.time()
    last_active = start_time
    hb_failures = 0

    while True:
        # Restart MediaMTX if it died.
        if mediamtx_proc.poll() is not None:
            log.warning("MediaMTX exited — restarting…")
            mediamtx_proc = start_mediamtx()

        # ── Config poll ───────────────────────────────────────────────────────
        cfg_resp = _api("GET", "/api/agent/config")
        if cfg_resp:
            outputs = cfg_resp.get("outputs", [])
            crop    = cfg_resp.get("crop", {})
            new_hash = json.dumps({"outputs": outputs, "crop": crop}, sort_keys=True)
            if new_hash != last_config_hash:
                last_known_config = {"outputs": outputs, "crop": crop}
                if prev_obs_connected:
                    log.info("Config changed — reapplying.")
                    sup.apply(last_known_config)
                else:
                    log.info("Config changed — stored (OBS not connected yet).")
                last_config_hash = new_hash

            credits_seconds = cfg_resp.get("credits_seconds", 0)
            if credits_seconds <= 0 and streaming:
                log.warning("Credits exhausted — stopping all outputs.")
                sup.stop_all()
                streaming = False

        # ── OBS connection state (hook.sh writes/clears /tmp/obs_connected) ──
        obs_connected = os.path.exists(OBS_FLAG)
        if obs_connected and not prev_obs_connected:
            # OBS just connected → SRT loopback is now publishing. Start runners
            # immediately (fresh start, bypasses any backoff from pre-connect retries).
            log.info("OBS connected — starting encoders immediately.")
            sup.cancel_pending_stop()
            if last_known_config:
                sup.apply(last_known_config)
            last_active = time.time()   # reset idle timer
        elif not obs_connected and prev_obs_connected:
            # OBS disconnected → schedule a grace-period stop so a quick
            # OBS reconnect cancels it without tearing down the encoders.
            log.info("OBS disconnected — scheduling grace stop.")
            sup.schedule_stop()
        prev_obs_connected = obs_connected

        # ── Heartbeat ──────────────────────────────────────────────────────────
        statuses = sup.status()
        streaming = any(s["state"] == "running" for s in statuses)
        if streaming:
            last_active = time.time()

        hb_resp = _api("POST", "/api/agent/status", {
            "outputs": statuses,
            "streaming": streaming,
        })

        if hb_resp is None:
            hb_failures += 1
            log.warning("Heartbeat failed (%d/%d).", hb_failures, HEARTBEAT_FAIL_LIMIT)
            if hb_failures >= HEARTBEAT_FAIL_LIMIT and streaming:
                log.error("No control-plane contact — stopping outputs (safety).")
                sup.stop_all()
                streaming = False
        else:
            hb_failures = 0
            command = hb_resp.get("command")
            if command == "stop":
                log.info("Received stop command (%s).", hb_resp.get("reason", ""))
                sup.stop_all()
                streaming = False
            elif command == "start":
                log.info("Received start command.")
                cfg_resp2 = _api("GET", "/api/agent/config") or {}
                if cfg_resp2:
                    sup.apply({"outputs": cfg_resp2.get("outputs", [])})

        # ── Watchdogs ──────────────────────────────────────────────────────────
        idle_for = time.time() - last_active
        if idle_for > IDLE_LIMIT_S:
            log.warning("Idle %ds — requesting termination.", int(idle_for))
            sup.stop_all()
            _api("POST", "/api/agent/terminate", {"reason": "idle"})

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()

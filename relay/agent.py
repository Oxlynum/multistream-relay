"""
agent.py — on-boot entrypoint for the SlimCast relay Docker container.

Replaces run.sh / start.sh. Responsibilities:
  1. Read SLIMCAST_API_KEY from environment (injected by RunPod at pod creation).
  2. POST /api/agent/pair → register IP, receive initial config.
  3. Start MediaMTX subprocess (ingest + SRT loopback).
  4. Start uvicorn (FastAPI control panel, debug only).
  5. Poll /api/agent/config every 10s → apply config changes via supervisor.
  6. POST /api/agent/status → heartbeat with live stream state.
  7. Handle stop commands in heartbeat response.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error

from supervisor import Supervisor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(message)s")
log = logging.getLogger("agent")

API_KEY = os.environ.get("SLIMCAST_API_KEY", "")
# Temporary dev/test domain — slimcast.com isn't owned yet. Provision passes the
# real callback URL via SLIMCAST_VERCEL_URL; this default is only a fallback.
VERCEL_URL = os.environ.get("SLIMCAST_VERCEL_URL", "https://slimcast-oxlynum.vercel.app")
POLL_INTERVAL = int(os.environ.get("AGENT_POLL_INTERVAL", "10"))
MEDIAMTX_CONFIG = os.environ.get("MEDIAMTX_CONFIG", "mediamtx.yml")

# ── Safety watchdogs ──────────────────────────────────────────────────────────
# Consecutive failed heartbeats before we stop encoding (control plane is gone,
# so the stream is unsupervised/unbilled — and the Vercel reaper will destroy
# this pod once its heartbeat goes stale).
HEARTBEAT_FAIL_LIMIT = int(os.environ.get("AGENT_HB_FAIL_LIMIT", "6"))   # ~60s
# No active outputs this long → abandoned; ask Vercel to destroy this pod.
IDLE_LIMIT_S = int(os.environ.get("AGENT_IDLE_LIMIT_S", str(5 * 60)))
# NOTE: the 12h session cap is now a confirmable deadline owned by the server
# (heartbeat returns command:'stop' at the deadline unless the user confirmed),
# so the agent intentionally no longer self-terminates on elapsed session time.

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
    """Returns the parsed JSON dict, or None if the call failed (so callers can
    distinguish an unreachable control plane from an empty response)."""
    url = f"{VERCEL_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Log status only — never the response body. Config/pair responses carry
        # stream keys, and we don't want any of that reaching pod logs.
        log.warning("API %s %s → %d", method, path, e.code)
        return None
    except Exception as exc:
        log.warning("API %s %s error: %s", method, path, exc)
        return None


def start_mediamtx() -> subprocess.Popen:
    log.info("Starting MediaMTX (%s)…", MEDIAMTX_CONFIG)
    proc = subprocess.Popen(["mediamtx", MEDIAMTX_CONFIG])
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

    # Pair with Vercel — register IP and receive initial config.
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
    initial_config = pair_resp.get("config", {})
    if initial_config:
        sup.apply(initial_config)
        log.info("Applied initial config (%d outputs)", len(build_outputs(initial_config)))

    last_config_hash = json.dumps(
        {"outputs": initial_config.get("outputs", []),
         "crop": initial_config.get("crop", {})},
        sort_keys=True,
    )

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
    last_active = start_time   # last time we had an active output
    hb_failures = 0

    while True:
        # Restart MediaMTX if it died.
        if mediamtx_proc.poll() is not None:
            log.warning("MediaMTX exited — restarting…")
            mediamtx_proc = start_mediamtx()

        # Poll config.
        cfg_resp = _api("GET", "/api/agent/config")
        if cfg_resp:
            outputs = cfg_resp.get("outputs", [])
            crop = cfg_resp.get("crop", {})
            # Hash outputs + crop together so a framing change re-applies the
            # portrait group (crop changes alter the FFmpeg command).
            new_hash = json.dumps({"outputs": outputs, "crop": crop}, sort_keys=True)
            if new_hash != last_config_hash:
                log.info("Config changed — reapplying.")
                sup.apply({"outputs": outputs, "crop": crop})
                last_config_hash = new_hash

            credits_seconds = cfg_resp.get("credits_seconds", 0)
            if credits_seconds <= 0 and streaming:
                log.warning("Credits exhausted — stopping all outputs.")
                sup.stop_all()
                streaming = False

        # Send heartbeat.
        statuses = sup.status()
        streaming = any(s["state"] == "running" for s in statuses)
        if streaming:
            last_active = time.time()

        hb_resp = _api("POST", "/api/agent/status", {
            "outputs": statuses,
            "streaming": streaming,
        })

        if hb_resp is None:
            # Control plane unreachable.
            hb_failures += 1
            log.warning("Heartbeat failed (%d/%d).", hb_failures, HEARTBEAT_FAIL_LIMIT)
            if hb_failures >= HEARTBEAT_FAIL_LIMIT and streaming:
                # Never keep streaming unsupervised. The Vercel reaper destroys
                # this pod once its heartbeat goes stale.
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

        # ── Watchdogs: proactively request our own teardown ──────────────────
        idle_for = time.time() - last_active
        if idle_for > IDLE_LIMIT_S:
            log.warning("Idle %ds (no active outputs) — requesting termination.", int(idle_for))
            sup.stop_all()
            _api("POST", "/api/agent/terminate", {"reason": "idle"})

        # The 12h session cap is now a *confirmable* deadline owned by the server:
        # the heartbeat returns command:'stop' at the deadline if the user didn't
        # confirm, and lets a confirmed stream continue. We deliberately do NOT
        # self-terminate on elapsed time here, so a confirmed long stream isn't
        # cut off. If the control plane goes silent, the heartbeat-fail watchdog
        # above already stops outputs and the Vercel reaper destroys the pod.

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()

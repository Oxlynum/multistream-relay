"""
agent.py — on-boot entrypoint for the SlimCast relay Docker container.

Replaces run.sh / start.sh. Responsibilities:
  1. Read SLIMCAST_API_KEY from environment (injected by the provider at pod creation).
  2. POST /api/agent/pair → register IP, receive initial config.
  3. Start MediaMTX subprocess (ingest + SRT loopback).
  4. Start uvicorn (FastAPI control panel, debug only).
  5. Poll /api/agent/config every 10s → store config; apply it once OBS connects.
  6. Watch /tmp/obs_connected (written by hook.sh) to know when OBS connects/drops.
     On connect  → immediately call sup.apply() so FFmpeg starts with a fresh retry
                   rather than waiting out whatever backoff the runners are in.
     On disconnect → start DISCONNECT_GRACE_S timer; if OBS doesn't reconnect,
                   stop encoders and call /api/agent/terminate. A reconnect within
                   the window cancels the timer (handles blips/OBS restarts).
  7. POST /api/agent/status → heartbeat with live stream state.
  8. Handle stop commands in heartbeat response.
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

# Per-pod secret ingest path (set by provision via SLIMCAST_INGEST_KEY). MediaMTX
# accepts only this path and republishes it over the SRT loopback. Encoders pull
# via SRT (MPEG-TS), NOT RTSP: RTP mangles Apple's temporal-layered HEVC.
# MediaMTX <v1.15.0 had a DTS extractor bug with Apple VT HEVC that caused the
# SRT muxer to close connections ("DTS is not monotonically increasing"). Fixed in
# v1.15.0 (issue #4892). We now require v1.19.1+. RELAY_SOURCE must be set BEFORE
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
# hook.sh signals this PID via SIGUSR1 to wake the poll loop immediately instead
# of waiting up to POLL_INTERVAL seconds before noticing the flag changed.
PID_FILE = "/tmp/agent.pid"

# ── Safety watchdogs ──────────────────────────────────────────────────────────
HEARTBEAT_FAIL_LIMIT = int(os.environ.get("AGENT_HB_FAIL_LIMIT", "6"))   # ~60s
# Seconds after OBS disconnects before we stop encoders and terminate the pod.
# A reconnect within this window (network blip, OBS restart) cancels the timer.
DISCONNECT_GRACE_S = int(os.environ.get("RELAY_DISCONNECT_GRACE", "20"))
# If OBS never connects within this many seconds of the pod being ready, terminate.
# Prevents paying for a pod that OBS can't reach (wrong region, port issue, etc.)
STARTUP_TIMEOUT_S = int(os.environ.get("RELAY_STARTUP_TIMEOUT", "120"))

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


# Outbound-reachability state for the broker's host probe. None = still testing.
_outbound_ok: "bool | None" = None


def _test_outbound() -> None:
    """Check the host can open OUTBOUND RTMP — the leg that delivers to the platforms.
    Some consumer hosts accept inbound + forward UDP but block outbound 1935, so a pod
    could ingest fine yet never reach Twitch (tee onfail=ignore hides it). We TCP-probe
    a Twitch ingest; the result rides on the UDP echo so the broker rejects a host that
    can't deliver, letting us safely use the FULL host pool instead of datacenter-only."""
    global _outbound_ok
    for host, port in (("live.twitch.tv", 1935),
                       ("ingest.global-contribute.live-video.net", 1935)):
        try:
            with socket.create_connection((host, port), timeout=6):
                _outbound_ok = True
                log.info("Outbound RTMP reachable (%s:%d)", host, port)
                return
        except Exception:
            continue
    _outbound_ok = False
    log.warning("Outbound RTMP blocked — host cannot deliver to platforms")


def start_udp_echo(port: int = 8889) -> None:
    """UDP echo carrying the broker's two Vast host checks in ONE round-trip:
      1. the reply existing proves the host FORWARDS UDP (required for SRT ingest);
      2. the reply prefix reports OUTBOUND reachability ('OK'/'BAD'/'PENDING') so the
         broker can reject a host that ingests but can't deliver to the platforms.
    Started early (before pairing) + in daemon threads; only active where the host
    maps the EXPOSE'd 8889/udp (Vast does via explicit -p flags)."""
    threading.Thread(target=_test_outbound, daemon=True).start()

    def _serve() -> None:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("0.0.0.0", port))
            log.info("UDP echo (Vast host probe) listening on :%d", port)
            while True:
                data, addr = sock.recvfrom(2048)
                status = (b"OK" if _outbound_ok is True
                          else b"BAD" if _outbound_ok is False else b"PENDING")
                sock.sendto(b"ECHO:" + status + b":" + data, addr)
        except Exception as exc:  # never crash the agent over the probe
            log.warning("UDP echo stopped: %s", exc)

    threading.Thread(target=_serve, daemon=True).start()


def build_outputs(config: dict) -> list[dict]:
    return config.get("outputs", [])


def _gpu_self_test(attempts: int = 2) -> bool:
    """Verify the container can actually reach the GPU before we depend on it.

    Some hosts (seen on Vast 'Secure' datacenter machines) attach the GPU at the
    host level — it shows in the provider's monitoring — but never inject the
    device into the container: the driver libraries mount, yet every NVENC/NVDEC
    call returns CUDA_ERROR_NO_DEVICE ("no CUDA-capable device is detected").
    The whole relay pipeline is GPU-only, so on such a host EVERY transcode dies
    in a ~6s FFmpeg restart loop and the user sees an endless "connecting" with
    nothing reaching the platforms (verified live, RTX 5090 host).

    Catch it at boot with a sub-second synthetic NVENC encode: it either succeeds
    (device present) or fails fast (device blind). Returns True iff NVENC works."""
    probe = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:r=5:d=0.2",
        "-c:v", "h264_nvenc", "-f", "null", "-",
    ]
    for i in range(attempts):
        try:
            r = subprocess.run(probe, capture_output=True, text=True, timeout=25)
            if r.returncode == 0:
                log.info("GPU self-test passed (NVENC encode OK).")
                return True
            tail = (r.stderr or "").strip().splitlines()
            log.warning("GPU self-test attempt %d/%d failed (code %d): %s",
                        i + 1, attempts, r.returncode, tail[-1] if tail else "(no stderr)")
        except subprocess.TimeoutExpired:
            log.warning("GPU self-test attempt %d/%d timed out.", i + 1, attempts)
        except Exception as exc:  # ffmpeg missing, etc. — treat as a failed probe
            log.warning("GPU self-test attempt %d/%d error: %s", i + 1, attempts, exc)
        if i + 1 < attempts:
            time.sleep(3)
    return False


def main() -> None:
    ip = _get_external_ip()
    log.info("External IP: %s", ip or "(unknown)")

    # Start the host probe (UDP echo + outbound test) BEFORE pairing, so the broker
    # can verify the host's networking even on hosts that block outbound to Twitch
    # (which would otherwise let the pod ingest but never deliver). Daemon threads.
    start_udp_echo()

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

    # GPU sanity gate. A host that can't inject the GPU into the container makes
    # every transcode fail in a restart loop (CUDA_ERROR_NO_DEVICE), which the
    # user just sees as a stream that never goes live. Fail fast and visibly by
    # HALTING the boot here — we exit WITHOUT starting MediaMTX, so the pod never
    # accepts RTMP. The broker's readiness probe (probeRtmp) then fails on this
    # candidate, it destroys the pod and cascades to the next-nearest machine —
    # often recovering within the same Start.
    #
    # Deliberately NOT calling /api/agent/terminate here: that runs teardownInstance
    # which DELETES the gpu_instances claim row, and during a live provision cascade
    # the broker is about to create the next pod and UPDATE that same row — deleting
    # it would orphan the next pod (it bills until the daily reaper). The broker's
    # own provider.destroy() on probe failure tears this pod down and leaves the row
    # intact, so a plain exit is both sufficient and safe.
    if not _gpu_self_test():
        log.error("GPU UNAVAILABLE — host did not expose a usable NVENC device to the "
                  "container (CUDA_ERROR_NO_DEVICE). Halting boot so the broker cascades "
                  "to another machine; not starting MediaMTX.")
        sys.exit(1)

    mediamtx_proc = start_mediamtx()
    uvicorn_proc = start_uvicorn()

    sup = Supervisor()

    # Write PID so hook.sh can wake us immediately via SIGUSR1 instead of
    # waiting up to POLL_INTERVAL seconds before the loop checks the flag.
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    wake_event = threading.Event()
    signal.signal(signal.SIGUSR1, lambda *_: wake_event.set())

    # Grace-terminate timer: fires DISCONNECT_GRACE_S after OBS drops.
    # Using a list as a mutable box so inner closures can replace the value.
    _disc_timer: list[threading.Timer | None] = [None]

    def _schedule_terminate() -> None:
        if _disc_timer[0]:
            _disc_timer[0].cancel()
        def _do() -> None:
            log.info("Grace period elapsed — OBS did not reconnect. Terminating pod.")
            sup.stop_all()
            _api("POST", "/api/agent/terminate", {"reason": "obs_disconnected"})
        t = threading.Timer(DISCONNECT_GRACE_S, _do)
        t.daemon = True
        t.start()
        _disc_timer[0] = t

    def _cancel_terminate() -> None:
        if _disc_timer[0]:
            _disc_timer[0].cancel()
            _disc_timer[0] = None

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
        try:
            os.unlink(PID_FILE)
        except FileNotFoundError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    streaming = False
    hb_failures = 0
    first_obs_connection = False
    startup_deadline = time.time() + STARTUP_TIMEOUT_S

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
        # ── Startup timeout ───────────────────────────────────────────────────
        # If OBS never connects within STARTUP_TIMEOUT_S of the pod being ready,
        # terminate — the pod is unreachable (wrong region, port issue, etc.).
        if not first_obs_connection and time.time() > startup_deadline:
            log.warning("OBS did not connect within %ds of pod ready — terminating.", STARTUP_TIMEOUT_S)
            _api("POST", "/api/agent/terminate", {"reason": "startup_timeout"})
            break

        obs_connected = os.path.exists(OBS_FLAG)
        if obs_connected and not prev_obs_connected:
            # OBS just connected (SIGUSR1 woke us instantly from hook.sh).
            # Cancel any pending grace-terminate from a previous disconnect,
            # then start encoders immediately with the cached config.
            log.info("OBS connected — starting encoders immediately.")
            first_obs_connection = True
            _cancel_terminate()
            sup.cancel_pending_stop()
            if last_known_config:
                sup.apply(last_known_config)
        elif not obs_connected and prev_obs_connected:
            # OBS disconnected. Start the grace timer: if OBS reconnects within
            # DISCONNECT_GRACE_S the timer is cancelled and encoders keep running.
            # If it doesn't, the timer stops encoders AND terminates the pod —
            # no need for a separate idle timer to handle this case.
            log.info("OBS disconnected — grace timer started (%ds). Pod terminates if OBS doesn't reconnect.", DISCONNECT_GRACE_S)
            _schedule_terminate()
        prev_obs_connected = obs_connected

        # ── Heartbeat ──────────────────────────────────────────────────────────
        statuses = sup.status()
        streaming = obs_connected or any(s["state"] == "running" for s in statuses)

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

        # Interruptible sleep: hook.sh sends SIGUSR1 when OBS connects/disconnects,
        # which sets wake_event and breaks out of the wait immediately instead of
        # burning up to POLL_INTERVAL seconds before the loop sees the flag change.
        wake_event.wait(timeout=POLL_INTERVAL)
        wake_event.clear()


if __name__ == "__main__":
    main()

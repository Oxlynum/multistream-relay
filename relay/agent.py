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
# Per-pod SRT AES passphrase (set by provision via SLIMCAST_SRT_PASSPHRASE). When
# present, MediaMTX requires it to publish/read this path and both the OBS uplink
# and the encoder loopback carry it, so the HEVC feed is AES-encrypted in flight.
# Empty locally → encryption disabled (the loopback is localhost-only there).
SRT_PASSPHRASE = os.environ.get("SLIMCAST_SRT_PASSPHRASE", "").strip()
# Encoder loopback read URL. Tuned for the localhost link: low latency (no jitter
# to absorb) + a short connect timeout so a not-yet-ready path fails fast and the
# OutputRunner restarts cleanly instead of hanging. Carries the passphrase when
# encryption is on. RELAY_SOURCE must be set BEFORE importing supervisor (it reads
# it at import time).
_loopback = f"srt://127.0.0.1:8890?streamid=read:{INGEST_KEY}&latency=120&timeout=5000000"
if SRT_PASSPHRASE:
    _loopback += f"&passphrase={SRT_PASSPHRASE}&pbkeylen=16"
os.environ.setdefault("RELAY_SOURCE", _loopback)

from supervisor import Supervisor
from budget import CostMeter, BudgetController, throttle_config, COST_CEILING_USD

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(message)s")
log = logging.getLogger("agent")

API_KEY    = os.environ.get("SLIMCAST_API_KEY", "")
VERCEL_URL = os.environ.get("SLIMCAST_VERCEL_URL", "https://slimcast-oxlynum.vercel.app")
POLL_INTERVAL = int(os.environ.get("AGENT_POLL_INTERVAL", "10"))
MEDIAMTX_CONFIG = os.environ.get("MEDIAMTX_CONFIG", "mediamtx.yml")

# Vast-injected env vars (confirmed available at container start — 2026-06-26).
# The pod uses these to self-report its own public URL without waiting for the
# cloud to probe it (push-readiness model, v2 broker).
PUBLIC_IPADDR     = os.environ.get("PUBLIC_IPADDR", "")
SRT_HOST_PORT     = os.environ.get("VAST_UDP_PORT_8890", "")   # SRT ingest (OBS → pod)
RTMP_HOST_PORT    = os.environ.get("VAST_TCP_PORT_1935", "")   # RTMP beacon
VAST_CONTAINER_LABEL = os.environ.get("VAST_CONTAINERLABEL", "")
# VAST_CONTAINERLABEL format is "C.<contract_id>" — the numeric part is the
# provider_id stored in gpu_instances.racers so the cloud can match this pod.
VAST_INSTANCE_ID = VAST_CONTAINER_LABEL[2:] if VAST_CONTAINER_LABEL.startswith("C.") else ""

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
# 180s (not 120): the SRT UDP port can take ~60s to map on Vast, and the dock can
# only hand OBS the srt:// URL after the broker finishes its readiness gate — so the
# OBS-connect clock effectively starts well after the agent pairs. 120s could expire
# mid-provision on a slow host and self-destruct a pod that was about to go live.
STARTUP_TIMEOUT_S = int(os.environ.get("RELAY_STARTUP_TIMEOUT", "180"))

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


def _post_ready() -> "dict | None":
    """v2 broker push-readiness: tell the cloud we are healthy and serving.

    Sends PUBLIC_IPADDR + mapped UDP/TCP ports (from Vast-injected env) so the
    cloud can save the SRT URL and hand it to OBS without probing us externally.

    In the parallel race model, the cloud CAS-selects the first pod to call
    this; the response says whether we WON (continue) or LOST (self-destruct).
    In the v1 broker path this is a belt-and-suspenders early save that the
    cloud ignores gracefully (it still does its own probe).
    """
    ip = PUBLIC_IPADDR or _get_external_ip()
    body = {
        "ip": ip,
        "srt_port": int(SRT_HOST_PORT) if SRT_HOST_PORT else None,
        "rtmp_port": int(RTMP_HOST_PORT) if RTMP_HOST_PORT else None,
        "container_label": VAST_CONTAINER_LABEL,
        "provider_id": VAST_INSTANCE_ID,
    }
    log.info("Reporting ready: ip=%s srt_port=%s rtmp_port=%s instance=%s",
             body["ip"], body["srt_port"], body["rtmp_port"], VAST_INSTANCE_ID or "?")
    for attempt in range(5):
        resp = _api("POST", "/api/agent/ready", body)
        if resp is not None:
            return resp
        log.warning("POST /api/agent/ready attempt %d failed, retrying in 3s…", attempt + 1)
        time.sleep(3)
    log.warning("POST /api/agent/ready all retries exhausted — assuming winner and continuing")
    return None


def _post_failed(reason: str) -> None:
    """v2 broker push-readiness: tell the cloud this pod cannot serve.

    Called on GPU self-test failure so the broker abandons this host in ~1s
    instead of waiting out the probe timeout (60–180s). Safe to call in v1
    path — the endpoint exists but the broker ignores the body.
    """
    body = {
        "reason": reason,
        "provider_id": VAST_INSTANCE_ID,
    }
    log.info("Reporting failed: reason=%s instance=%s", reason, VAST_INSTANCE_ID or "?")
    _api("POST", "/api/agent/failed", body)


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
    """Substitute the per-pod ingest path + SRT passphrase into the MediaMTX template."""
    with open(MEDIAMTX_CONFIG) as f:
        cfg = f.read()
    cfg = cfg.replace("__INGEST_PATH__", INGEST_KEY)
    if SRT_PASSPHRASE:
        cfg = cfg.replace("__SRT_PASSPHRASE__", SRT_PASSPHRASE)
    else:
        # No passphrase (local/dev): strip the encryption lines so MediaMTX runs
        # the path unencrypted rather than choking on the literal placeholder.
        cfg = "\n".join(l for l in cfg.splitlines() if "__SRT_PASSPHRASE__" not in l)
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


def start_uvicorn(sup: "Supervisor") -> None:
    """Run the debug panel in-process so it shares the live supervisor instance.

    Previously launched as a subprocess, which meant app.py created its own
    empty Supervisor and /api/logs/* always returned nothing mid-stream (the
    dual-supervisor gap). Running in a daemon thread lets app.py call
    sup_mod.get_active() and reach the real pipeline's ring buffers.
    """
    import supervisor as sup_mod
    import uvicorn
    import app as _app_mod  # noqa: F401 — imported to register routes

    sup_mod.set_active(sup)

    config = uvicorn.Config(
        "app:app",
        host="0.0.0.0",
        port=8080,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True, name="uvicorn-panel")
    t.start()
    log.info("Control panel starting on :8080 (in-process)")


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


def _driver_version() -> str:
    """Host GPU driver version (for accurate self-test failure reporting)."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                            capture_output=True, text=True, timeout=10)
        return (r.stdout or "").strip().splitlines()[0].strip() or "?"
    except Exception:
        return "?"


def _nvenc_fail_reason(stderr: str) -> str:
    """Pull the meaningful NVENC error out of ffmpeg stderr.

    Prefer the encoder's own diagnosis (e.g. 'OpenEncodeSessionEx failed:
    unsupported device', 'No capable devices found', 'Cannot load
    libnvidia-encode', 'minimum required Nvidia driver') over ffmpeg's generic
    trailer ('Nothing was written...'), so the boot log states the TRUE cause."""
    lines = [l.strip() for l in (stderr or "").splitlines() if l.strip()]
    keys = ("openencodesession", "unsupported device", "no capable devices",
            "cannot load", "minimum required", "nvenc", "cuda")
    for l in lines:
        low = l.lower()
        if any(k in low for k in keys) and "nothing was written" not in low:
            return l
    return lines[-1] if lines else "(no stderr)"


def _gpu_self_test(attempts: int = 2) -> tuple[bool, str]:
    """Verify the container can actually open an NVENC session AND decode (NVDEC).

    This is GPU-only, so a host that can't do it would crash-loop the live
    transcode — we fail fast at boot instead. Two passes (both must succeed):
      1. H.264 NVENC from lavfi  — encode/session opens at all.
      2. H.264 NVDEC -> NVENC    — decode + re-encode works.
    Returns (ok, reason). On failure, `reason` is the real NVENC error — most
    commonly 'OpenEncodeSessionEx failed: unsupported device', the NVIDIA driver
    570/580+ NVENC-in-container regression (nvidia-container-toolkit#1249): the GPU
    is fine but this driver branch can't hand NVENC to the container. No ffmpeg
    version or in-container tweak fixes it; the cure is a good-driver host, so the
    broker should cascade. (Historically this was mislabeled CUDA_ERROR_NO_DEVICE.)"""
    import tempfile, os as _os
    reason = "(no stderr)"

    for i in range(attempts):
        tmp = tempfile.mktemp(suffix=".h264")
        try:
            enc = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=128x128:r=5:d=0.4",
                "-c:v", "h264_nvenc", "-f", "h264", tmp,
            ], capture_output=True, text=True, timeout=25)
            if enc.returncode != 0:
                reason = _nvenc_fail_reason(enc.stderr)
                log.warning("GPU self-test attempt %d/%d NVENC encode failed (code %d): %s",
                            i + 1, attempts, enc.returncode, reason)
                continue

            dec = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-i", tmp,
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ], capture_output=True, text=True, timeout=25)
            if dec.returncode == 0:
                log.info("GPU self-test passed (NVENC + NVDEC both OK).")
                return True, ""
            reason = _nvenc_fail_reason(dec.stderr)
            log.warning("GPU self-test attempt %d/%d NVDEC failed (code %d): %s",
                        i + 1, attempts, dec.returncode, reason)
        except subprocess.TimeoutExpired:
            log.warning("GPU self-test attempt %d/%d timed out.", i + 1, attempts)
            reason = "ffmpeg timed out"
        except Exception as exc:
            log.warning("GPU self-test attempt %d/%d error: %s", i + 1, attempts, exc)
            reason = str(exc)
        finally:
            try:
                _os.unlink(tmp)
            except FileNotFoundError:
                pass
        if i + 1 < attempts:
            time.sleep(3)
    return False, reason


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
    ok, reason = _gpu_self_test()
    if not ok:
        drv = _driver_version()
        low = reason.lower()
        if "unsupported device" in low or "no capable devices" in low:
            log.error("NVENC UNUSABLE on this host (driver %s): %s. This is the NVIDIA "
                      "driver 570/580+ NVENC-in-container regression "
                      "(nvidia-container-toolkit#1249) — the GPU is fine, but this driver "
                      "branch can't hand NVENC to the container, and no ffmpeg version or "
                      "in-container fix resolves it. Halting boot so the broker cascades to "
                      "a good-driver host; not starting MediaMTX.", drv, reason)
        else:
            log.error("GPU self-test FAILED (driver %s): %s. Halting boot so the broker "
                      "cascades to another machine; not starting MediaMTX.", drv, reason)
        # v2 broker: report failure immediately so the cloud abandons this host in
        # ~1s (instead of waiting out the 60–180s probe timeout). The cloud will
        # kick the next race round if all racers fail. v1 broker: the endpoint
        # exists and returns {ack:true}; the v1 broker still relies on probeRtmp
        # failing — this POST is harmless belt-and-suspenders.
        _post_failed(f"{reason} (driver {drv})")
        sys.exit(1)

    mediamtx_proc = start_mediamtx()
    sup = Supervisor()
    start_uvicorn(sup)  # in-process daemon thread; shares sup with app.py

    # v2 broker push-readiness: now that MediaMTX is up and ports are mapped,
    # tell the cloud we are healthy and serving. The cloud CAS-selects the first
    # pod to report ready; if we LOST the race, exit cleanly (the winner handles
    # the session). If the POST fails, assume we're the winner and continue.
    ready_resp = _post_ready()
    if ready_resp is not None and not ready_resp.get("winner", True):
        action = ready_resp.get("action", "")
        log.info("Lost race (another pod won this session) — action=%s, exiting.", action)
        sup.stop_all()
        mediamtx_proc.terminate()
        sys.exit(0)

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
        # uvicorn panel is a daemon thread — it exits when the process does
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
    # Live infrastructure-cost meter + budget-throttle controller. The meter samples
    # /proc/net/dev each heartbeat for the pod's real $/hr; the controller turns that
    # into a quality tier (down-fast/up-slow) that caps transcode bitrate/resolution
    # and the suggested OBS source bitrate — degrading quality instead of killing the
    # stream when bandwidth would cross the ceiling.
    cost_meter = CostMeter()
    controller = BudgetController(COST_CEILING_USD)
    # Signature of the last config we handed to the supervisor: (config_hash, tier).
    # Re-apply when EITHER the user's config OR the throttle tier changes — reset to
    # None on OBS disconnect so a reconnect always re-applies.
    last_applied_sig: tuple[str, int] | None = None
    log.info("Budget controller active — ceiling $%.2f/hr.", COST_CEILING_USD)

    while True:
        # Restart MediaMTX if it died.
        if mediamtx_proc.poll() is not None:
            log.warning("MediaMTX exited — restarting…")
            mediamtx_proc = start_mediamtx()

        # ── Config poll (store only; the throttle-aware apply step below is the
        #    single place that hands config to the supervisor) ───────────────────
        cfg_resp = _api("GET", "/api/agent/config")
        if cfg_resp:
            outputs = cfg_resp.get("outputs", [])
            crop    = cfg_resp.get("crop", {})
            new_hash = json.dumps({"outputs": outputs, "crop": crop}, sort_keys=True)
            if new_hash != last_config_hash:
                last_known_config = {"outputs": outputs, "crop": crop}
                last_config_hash = new_hash
                log.info("Config changed — will (re)apply at the current throttle tier.")

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
            # OBS just connected (SIGUSR1 woke us instantly from hook.sh). Cancel any
            # pending grace-terminate from a previous disconnect. The apply step below
            # starts encoders this same iteration (sig reset → forced re-apply).
            log.info("OBS connected — starting encoders immediately.")
            first_obs_connection = True
            _cancel_terminate()
            sup.cancel_pending_stop()
            last_applied_sig = None
        elif not obs_connected and prev_obs_connected:
            # OBS disconnected. Start the grace timer: if OBS reconnects within
            # DISCONNECT_GRACE_S the timer is cancelled and encoders keep running.
            # If it doesn't, the timer stops encoders AND terminates the pod —
            # no need for a separate idle timer to handle this case.
            log.info("OBS disconnected — grace timer started (%ds). Pod terminates if OBS doesn't reconnect.", DISCONNECT_GRACE_S)
            _schedule_terminate()
            last_applied_sig = None   # force re-apply when OBS comes back
        prev_obs_connected = obs_connected

        # ── Budget controller: measure cost → pick a quality tier ───────────────
        # None on the first beat (no /proc/net/dev delta yet) → controller holds at
        # the user's entitled floor until a real measurement arrives.
        cost = cost_meter.sample()
        controller.set_floor_from_config(last_known_config or {})
        tier_spec = controller.update(cost["projected_usd_hr"] if cost else None)
        if cost:
            log.info("Cost: $%.3f/hr (egress %.2f, ingress %.2f GB/hr) → tier %d%s (ceiling $%.2f)",
                     cost["projected_usd_hr"], cost["egress_gb_hr"], cost["ingress_gb_hr"],
                     controller.tier, " THROTTLED" if controller.throttled else "", COST_CEILING_USD)

        # ── Apply config at the current tier (only with OBS up & something changed) ──
        if obs_connected and last_known_config:
            sig = (last_config_hash, controller.tier)
            if sig != last_applied_sig:
                if controller.throttled:
                    log.info("Throttle tier %d: landscape≤%dk portrait≤%dk res≤%dp source≈%sk",
                             controller.tier, tier_spec["landscape_kbps"], tier_spec["portrait_kbps"],
                             tier_spec["max_height"], controller.suggested_ingest_kbps())
                sup.apply(throttle_config(last_known_config, tier_spec))
                last_applied_sig = sig

        # ── Heartbeat ──────────────────────────────────────────────────────────
        statuses = sup.status()
        streaming = obs_connected or any(s["state"] == "running" for s in statuses)

        hb_body = {
            "outputs": statuses,
            "streaming": streaming,
            # Throttle state — the suggested OBS source bitrate is the lever the
            # plugin applies to cut ingress + YouTube passthrough (consumed in Phase 3).
            "throttle": {
                "tier": controller.tier,
                "active": controller.throttled,
                "suggested_ingest_kbps": controller.suggested_ingest_kbps(),
            },
        }
        if cost:
            hb_body["cost"] = cost
        hb_resp = _api("POST", "/api/agent/status", hb_body)

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
                    last_known_config = {"outputs": cfg_resp2.get("outputs", []), "crop": cfg_resp2.get("crop", {})}
                    last_config_hash = json.dumps(last_known_config, sort_keys=True)
                    controller.set_floor_from_config(last_known_config)
                    sup.apply(throttle_config(last_known_config, controller.current()))
                    last_applied_sig = (last_config_hash, controller.tier)

        # Interruptible sleep: hook.sh sends SIGUSR1 when OBS connects/disconnects,
        # which sets wake_event and breaks out of the wait immediately instead of
        # burning up to POLL_INTERVAL seconds before the loop sees the flag change.
        wake_event.wait(timeout=POLL_INTERVAL)
        wake_event.clear()


if __name__ == "__main__":
    main()

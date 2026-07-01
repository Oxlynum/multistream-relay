"""
agent.py — on-boot entrypoint for the SlimCast relay Docker container.

One image, two data-plane roles selected by the RELAY_ROLE env var:

  RELAY_ROLE=vps (main_vps): a card-less Hetzner CPU hub. Runs one MediaMTX
    (wildcard SRT path) for OBS ingest, polls /api/agent/hub-config, and
    reconciles one Supervisor per tenant — passthrough delivery to the
    platforms plus, when a GPU backend is paired, source-forward over the
    mpegts-over-TLS bridge and the RTMPS-return fan-out. Skips the GPU
    self-test. Stream keys live here; they never reach the GPU.

  RELAY_ROLE=gpu (main_gpu): a Vast GPU backend behind a hub. Runs the GPU
    self-test (the one role that needs NVENC/NVDEC), receives the tenant
    source as mpegts-over-TLS on :8899, NVDEC→NVENC transcodes per
    orientation, and returns RTMPS H.264 to the hub. No MediaMTX, no
    OBS-flag lifecycle — driven by /api/agent/gpu-config.

Both roles authenticate to Vercel with their own SLIMCAST_API_KEY and report
readiness via POST /api/agent/ready. The legacy all-in-one role (direct
OBS→GPU, keys on the GPU) has been removed; an unknown/blank RELAY_ROLE is
fatal (main() raises) rather than silently running a deleted path.
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

# Per-pod SRT AES passphrase (set by provision via SLIMCAST_SRT_PASSPHRASE). When
# present, MediaMTX requires it to publish/read this path and both the OBS uplink
# and the encoder loopback carry it, so the HEVC feed is AES-encrypted in flight.
# Empty locally → encryption disabled (the loopback is localhost-only there).
SRT_PASSPHRASE = os.environ.get("SLIMCAST_SRT_PASSPHRASE", "").strip()

from supervisor import Supervisor, BRIDGE_AUTH, BRIDGE_BACKEND_PORT, BRIDGE_PROXY
from budget import CostMeter

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(message)s")
log = logging.getLogger("agent")

API_KEY    = os.environ.get("SLIMCAST_API_KEY", "")
VERCEL_URL = os.environ.get("SLIMCAST_VERCEL_URL", "https://slimcast-oxlynum.vercel.app")
POLL_INTERVAL = int(os.environ.get("AGENT_POLL_INTERVAL", "10"))

# RELAY_ROLE — data-plane role. One image, two roles:
#   'vps' : Hetzner CPU hub — SRT ingest from OBS + passthrough delivery + (for transcode)
#           source-forward to a GPU over the TLS bridge and platform fan-out. SKIPS the
#           GPU self-test. Stream keys live here; they never reach the GPU.
#   'gpu' : Vast GPU backend — receives the source as mpegts-over-TLS on :8899, NVDEC→NVENC
#           transcodes, returns one RTMPS stream per orientation to the VPS. Never a tee.
# The legacy all-in-one role (direct OBS→GPU) was removed: a blank/unknown role is NOT
# coerced to a default, so main() raises rather than silently running a deleted path.
RELAY_ROLE = os.environ.get("RELAY_ROLE", "").strip()
if RELAY_ROLE not in ("vps", "gpu"):
    log.warning("RELAY_ROLE=%r is not one of ('vps','gpu') — main() will refuse to start", RELAY_ROLE)
log.info("RELAY_ROLE=%s", RELAY_ROLE)

# VPS hub identity + config (RELAY_ROLE=vps; set by cloud-init). The hub authenticates
# to /api/agent/{hub-config,ready,status} with its own SLIMCAST_API_KEY ('vps' key);
# HUB_ID lets the cloud resolve which hub is reporting.
HUB_ID = os.environ.get("SLIMCAST_HUB_ID", "").strip()
MEDIAMTX_VPS_CONFIG = os.environ.get("MEDIAMTX_VPS_CONFIG", "mediamtx.vps.yml")

# Vast-injected env vars (confirmed available at container start — 2026-06-26).
# The pod uses these to self-report its own public URL without waiting for the
# cloud to probe it (push-readiness model, v2 broker).
PUBLIC_IPADDR     = os.environ.get("PUBLIC_IPADDR", "")
VAST_CONTAINER_LABEL = os.environ.get("VAST_CONTAINERLABEL", "")
# VAST_CONTAINERLABEL format is "C.<contract_id>" — the numeric part is the
# provider_id stored in gpu_instances.racers so the cloud can match this pod.
VAST_INSTANCE_ID = VAST_CONTAINER_LABEL[2:] if VAST_CONTAINER_LABEL.startswith("C.") else ""

# Provider-neutral self-identity (Phase 2, item 5). The web side injects SLIMCAST_PROVIDER
# at create; each provider exposes its own instance-id env. PROVIDER_ID is whichever the
# host injected — the cloud ALSO resolves the winner from the sole-booting racer, so this
# is a best-effort hint, never load-bearing. A new provider just needs its id read here.
SLIMCAST_PROVIDER = os.environ.get("SLIMCAST_PROVIDER", "")
RUNPOD_POD_ID = os.environ.get("RUNPOD_POD_ID", "")
PROVIDER_ID = VAST_INSTANCE_ID or RUNPOD_POD_ID

# Flag file written by hook.sh when OBS publishes to MediaMTX (runOnReady).
# Cleared when OBS drops (runOnNotReady). Agent uses this to start/stop the
# supervisor in sync with OBS instead of starting at pod boot.
OBS_FLAG = "/tmp/obs_connected"
# hook.sh signals this PID via SIGUSR1 to wake the poll loop immediately instead
# of waiting up to POLL_INTERVAL seconds before noticing the flag changed.
PID_FILE = "/tmp/agent.pid"

# ── Safety watchdogs ──────────────────────────────────────────────────────────
HEARTBEAT_FAIL_LIMIT = int(os.environ.get("AGENT_HB_FAIL_LIMIT", "6"))   # ~60s

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
    """Verify the container can open NVENC and NVDEC for both H.264 and HEVC.

    Three passes — all must succeed:
      1. H.264 NVENC from lavfi        — NVENC session opens at all.
      2. H.264 NVDEC -> H.264 NVENC    — CUDA decode pipeline works.
      3. HEVC NVENC from lavfi -> HEVC NVDEC — HEVC decode works (the actual
         OBS ingest codec). This is the pass that machine 67876 would have
         failed had we tested it at boot (passed H.264 but died on HEVC NVDEC).
    Returns (ok, reason). On failure, `reason` is the real error."""
    import tempfile, os as _os
    reason = "(no stderr)"

    for i in range(attempts):
        h264_tmp = tempfile.mktemp(suffix=".h264")
        hevc_tmp = tempfile.mktemp(suffix=".hevc")
        try:
            # Pass 1: H.264 NVENC encode
            # 320x240: safely above NVENC's minimum frame dimension on all drivers.
            # 128x128 fails on driver ≥570 with "Frame Dimension less than minimum".
            enc = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=320x240:r=5:d=0.4",
                "-c:v", "h264_nvenc", "-f", "h264", h264_tmp,
            ], capture_output=True, text=True, timeout=25)
            if enc.returncode != 0:
                reason = _nvenc_fail_reason(enc.stderr)
                log.warning("GPU self-test attempt %d/%d H.264 NVENC failed (code %d): %s",
                            i + 1, attempts, enc.returncode, reason)
                continue

            # Pass 2: H.264 NVDEC -> NVENC (decode pipeline)
            dec = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-i", h264_tmp,
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ], capture_output=True, text=True, timeout=25)
            if dec.returncode != 0:
                reason = _nvenc_fail_reason(dec.stderr)
                log.warning("GPU self-test attempt %d/%d H.264 NVDEC failed (code %d): %s",
                            i + 1, attempts, dec.returncode, reason)
                continue

            # Pass 3: HEVC NVENC encode then HEVC NVDEC decode.
            # OBS sends HEVC; this is the codec that can pass NVENC but fail NVDEC
            # on certain hosts (e.g. machine 67876 — passed H.264 but died on HEVC).
            hevc_enc = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=320x240:r=5:d=0.4",
                "-c:v", "hevc_nvenc", "-f", "hevc", hevc_tmp,
            ], capture_output=True, text=True, timeout=25)
            if hevc_enc.returncode != 0:
                reason = _nvenc_fail_reason(hevc_enc.stderr)
                log.warning("GPU self-test attempt %d/%d HEVC NVENC failed (code %d): %s",
                            i + 1, attempts, hevc_enc.returncode, reason)
                continue

            hevc_dec = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-i", hevc_tmp,
                "-f", "null", "-",
            ], capture_output=True, text=True, timeout=25)
            if hevc_dec.returncode == 0:
                log.info("GPU self-test passed (H.264 NVENC + NVDEC + HEVC NVENC + NVDEC all OK).")
                return True, ""
            reason = _nvenc_fail_reason(hevc_dec.stderr)
            log.warning("GPU self-test attempt %d/%d HEVC NVDEC failed (code %d): %s",
                        i + 1, attempts, hevc_dec.returncode, reason)
        except subprocess.TimeoutExpired:
            log.warning("GPU self-test attempt %d/%d timed out.", i + 1, attempts)
            reason = "ffmpeg timed out"
        except Exception as exc:
            log.warning("GPU self-test attempt %d/%d error: %s", i + 1, attempts, exc)
            reason = str(exc)
        finally:
            for f in (h264_tmp, hevc_tmp):
                try:
                    _os.unlink(f)
                except FileNotFoundError:
                    pass
        if i + 1 < attempts:
            time.sleep(3)
    return False, reason


# ── VPS hub role (RELAY_ROLE=vps) ───────────────────────────────────────────────

def _render_mediamtx_vps_config() -> str:
    """Render the VPS hub MediaMTX config: substitute the shared SRT passphrase into
    the wildcard-path template (or strip the encryption lines if none is set)."""
    with open(MEDIAMTX_VPS_CONFIG) as f:
        cfg = f.read()
    if SRT_PASSPHRASE:
        cfg = cfg.replace("__SRT_PASSPHRASE__", SRT_PASSPHRASE)
    else:
        cfg = "\n".join(l for l in cfg.splitlines() if "__SRT_PASSPHRASE__" not in l)
    runtime_path = "/tmp/mediamtx.runtime.yml"
    with open(runtime_path, "w") as f:
        f.write(cfg)
    return runtime_path


def start_mediamtx_vps() -> subprocess.Popen:
    config = _render_mediamtx_vps_config()
    log.info("Starting MediaMTX (VPS hub, wildcard path)…")
    proc = subprocess.Popen(["mediamtx", config])
    time.sleep(2)
    if proc.poll() is not None:
        log.error("MediaMTX exited immediately (code %s)", proc.returncode)
        sys.exit(1)
    log.info("MediaMTX running (pid %d)", proc.pid)
    return proc


def _post_ready_vps(ip: str) -> None:
    """Hub self-reports healthy → cloud flips vps_hubs.status to 'live' and promotes
    attached tenants. Deterministic (no winner/CAS race like the GPU pod path)."""
    body = {"role": "vps", "hub_id": HUB_ID, "ip": ip, "srt_port": 8890, "rtmp_port": 1935}
    log.info("Reporting hub ready: hub_id=%s ip=%s", HUB_ID or "?", ip)
    for attempt in range(5):
        if _api("POST", "/api/agent/ready", body) is not None:
            return
        log.warning("POST /api/agent/ready (vps) attempt %d failed, retrying in 3s…", attempt + 1)
        time.sleep(3)
    log.warning("POST /api/agent/ready (vps) all retries exhausted — continuing")


def main_vps() -> None:
    """RELAY_ROLE=vps: a card-less Hetzner hub serving N tenants' passthrough streams.

    No GPU self-test. One MediaMTX (wildcard path). Polls /api/agent/hub-config and
    reconciles one Supervisor per tenant (dict[ingest_key -> Supervisor]); per-tenant
    OBS connect/disconnect comes from the per-path hook flags (/tmp/obs_connected.<key>).
    Reports per-tenant streaming to /api/agent/status (role='vps'). It NEVER calls
    /api/agent/terminate — that would kill the whole shared box; tenant teardown is the
    cloud's Clock A (a torn-down tenant simply drops out of hub-config and we stop it).
    """
    if not HUB_ID:
        log.error("RELAY_ROLE=vps but SLIMCAST_HUB_ID is not set — cannot run as a hub.")
        sys.exit(1)

    ip = PUBLIC_IPADDR or _get_external_ip()
    log.info("VPS hub %s starting. External IP: %s", HUB_ID, ip or "(unknown)")

    # MediaMTX binds the RTMPS :1936 GPU-return server at startup and needs the TLS
    # cert present on disk — generate it before the server comes up (idempotent).
    _gen_self_signed_cert()
    mediamtx_proc = start_mediamtx_vps()
    _post_ready_vps(ip)

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    wake_event = threading.Event()
    signal.signal(signal.SIGUSR1, lambda *_: wake_event.set())

    # ingest_key -> {"sup": Supervisor, "applied_hash": str | None}
    tenants: dict[str, dict] = {}

    def shutdown(sig: int, _frame: object) -> None:
        log.info("Received signal %d — shutting down hub…", sig)
        for t in tenants.values():
            t["sup"].stop_all()
        mediamtx_proc.terminate()
        try:
            os.unlink(PID_FILE)
        except FileNotFoundError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        if mediamtx_proc.poll() is not None:
            log.warning("MediaMTX exited — restarting…")
            mediamtx_proc = start_mediamtx_vps()

        resp = _api("GET", "/api/agent/hub-config")
        streams = (resp or {}).get("streams", []) if resp else []
        wanted = {s["ingest_key"]: s for s in streams if s.get("ingest_key")}

        # Drop tenants the cloud no longer assigns (detached / torn down by Clock A).
        for key in list(tenants):
            if key not in wanted:
                log.info("Tenant %s… detached — stopping its pipeline.", key[:8])
                tenants.pop(key)["sup"].stop_all()

        report: list[dict] = []
        for key, s in wanted.items():
            t = tenants.get(key)
            if t is None:
                pp = (s.get("srt_passphrase") or "").strip()
                src = f"srt://127.0.0.1:8890?streamid=read:{key}&latency=120&timeout=5000000"
                if pp:
                    src += f"&passphrase={pp}&pbkeylen=16"
                t = {"sup": Supervisor(source=src, role="vps"), "applied_hash": None}
                tenants[key] = t
                log.info("Tenant %s… attached — pipeline ready (waiting for OBS).", key[:8])

            connected = os.path.exists(f"{OBS_FLAG}.{key}")
            # `bridge` (present only when this tenant has a 'ready' GPU backend, set by
            # hub-config) drives the source_forward → GPU + deliver ← GPU runners. Folded
            # into the cfg hash so a GPU coming up / going down re-applies the pipeline
            # (degrade gracefully: no bridge → passthrough/ertmp only, never direct-to-GPU).
            cfg = {"outputs": s.get("outputs", []), "crop": s.get("crop", {}), "bridge": s.get("bridge")}
            cfg_hash = json.dumps(cfg, sort_keys=True)

            if connected:
                t["sup"].cancel_pending_stop()
                if cfg_hash != t["applied_hash"]:
                    log.info("Tenant %s… OBS publishing — applying %d output(s).", key[:8], len(cfg["outputs"]))
                    t["sup"].apply(cfg)
                    t["applied_hash"] = cfg_hash
            elif t["applied_hash"] is not None:
                log.info("Tenant %s… OBS dropped — grace-stopping its pipeline.", key[:8])
                t["sup"].schedule_stop()
                t["applied_hash"] = None

            # Per-platform output state for the OBS dock's status dots. Each runner
            # reports {state, platforms}, and since the STREAM-02 de-tee EVERY runner carries
            # exactly ONE platform: passthrough/ertmp (YouTube / Twitch-eRTMP) and one
            # deliver:<platform> per transcode platform (Twitch-H.264, Kick, TikTok no longer
            # share a tee), so a dropped platform reports its OWN 'restarting'/'error' instead
            # of riding a neighbour's 'running'. Runners with no platforms (source_forward) are
            # dropped. Only report while OBS is publishing — once it drops the runners linger in
            # a 'stopped' state that the dock would misread as "connecting…" rather than idle;
            # an empty list is the honest "idle" signal.
            outputs = (
                [
                    {"state": r["state"], "platforms": r["platforms"]}
                    for r in t["sup"].status()
                    if r.get("platforms")
                ]
                if connected
                else []
            )
            report.append({"ingest_key": key, "streaming": connected, "outputs": outputs})

        hb = _api("POST", "/api/agent/status", {"role": "vps", "hub_id": HUB_ID, "streams": report})
        if hb and hb.get("command") == "stop" and hb.get("reason") == "scale_to_zero":
            log.info("Cloud scaled this hub to zero — shutting down.")
            for t in tenants.values():
                t["sup"].stop_all()
            mediamtx_proc.terminate()
            sys.exit(0)

        wake_event.wait(timeout=POLL_INTERVAL)
        wake_event.clear()


# ── GPU backend role (RELAY_ROLE=gpu) ───────────────────────────────────────────

def _gen_self_signed_cert() -> None:
    """Generate /app/relay.{crt,key} for the TLS legs (mpegts-TLS listener on the GPU,
    RTMPS return on the VPS). agent.py is the container entrypoint (no startup script),
    so the cert must be made here. Idempotent."""
    if os.path.exists("/app/relay.crt") and os.path.exists("/app/relay.key"):
        return
    try:
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048",
             "-keyout", "/app/relay.key", "-out", "/app/relay.crt",
             "-days", "3650", "-nodes", "-subj", "/CN=relay"],
            check=True, capture_output=True, timeout=30,
        )
        log.info("Generated self-signed TLS cert (/app/relay.crt).")
    except Exception as exc:
        log.error("TLS cert generation failed: %s", exc)


def _start_bridge_gateway() -> "subprocess.Popen":
    """SEC-03: start the authenticating mpegts gateway (bridge_proxy.py server) on the PUBLIC
    :8899. It terminates TLS, validates the SLIMCAST_BRIDGE_SECRET preamble, then splices an
    authenticated connection to ffmpeg on 127.0.0.1:BRIDGE_BACKEND_PORT. Runs for the life of
    the pod; if it ever dies the bridge goes dark (fail-closed) rather than open. The secret
    is read from this process's env by the gateway — never passed on argv."""
    proc = subprocess.Popen(
        [sys.executable, BRIDGE_PROXY, "server",
         "--listen-port", "8899",
         "--backend-host", "127.0.0.1", "--backend-port", str(BRIDGE_BACKEND_PORT),
         "--cert-file", "/app/relay.crt", "--key-file", "/app/relay.key"],
        start_new_session=True,
    )
    log.info("bridge_proxy auth gateway started on :8899 → ffmpeg 127.0.0.1:%d", BRIDGE_BACKEND_PORT)
    return proc


def _post_ready_gpu(ip: str, bridge_port: "int | None") -> "dict | None":
    """GPU backend self-reports its bridge-in address. Winner-CAS on the cloud side;
    a loser is told to self-destruct."""
    body = {"role": "gpu", "ip": ip, "bridge_port": bridge_port, "provider_id": PROVIDER_ID}
    log.info("Reporting gpu ready: ip=%s bridge_port=%s instance=%s", ip, bridge_port, PROVIDER_ID or "?")
    for attempt in range(5):
        resp = _api("POST", "/api/agent/ready", body)
        if resp is not None:
            return resp
        log.warning("POST /api/agent/ready (gpu) attempt %d failed, retrying in 3s…", attempt + 1)
        time.sleep(3)
    log.error("POST /api/agent/ready (gpu) all retries exhausted — readiness UNCONFIRMED "
              "(caller aborts so the broker re-races).")
    return None


def main_gpu() -> None:
    """RELAY_ROLE=gpu: a GPU backend behind a VPS hub. Receives the tenant's source
    HEVC as mpegts-over-TLS on a raw listener, NVDEC→NVENC transcodes per orientation,
    and returns RTMPS H.264 to the VPS. No MediaMTX, no OBS-flag lifecycle — driven by
    /api/agent/gpu-config. KEEPS the GPU self-test (the one role that needs NVENC)."""
    ip = PUBLIC_IPADDR or _get_external_ip()
    # The provider maps our EXPOSE'd 8899/tcp to a public port and injects it as env.
    # Provider-neutral (Phase 2, item 5): try the known names first, then fall back to ANY
    # *_TCP_PORT_8899 the host injected — so a new provider's port shows up with zero code
    # change here (its env just has to follow the <PROVIDER>_TCP_PORT_<container> convention).
    bridge_port_s = (
        os.environ.get("VAST_TCP_PORT_8899", "")
        or os.environ.get("RUNPOD_TCP_PORT_8899", "")
        or next((v for k, v in os.environ.items() if k.endswith("_TCP_PORT_8899") and v), "")
    )
    bridge_port = int(bridge_port_s) if bridge_port_s else None
    log.info("GPU backend starting. provider=%s ip=%s bridge_port=%s instance=%s",
             SLIMCAST_PROVIDER or "?", ip or "?", bridge_port or "?", PROVIDER_ID or "?")

    # Fail-safe: if the provider mapped no public 8899, the hub can NEVER connect the
    # mpegts-over-TLS bridge to us — we'd boot, pass the self-test, then heartbeat + bill
    # for the whole session doing zero work, invisible to every reaper (we'd "assume winner"
    # below and never exit). Report failed so the broker re-races onto a host that DOES map
    # the bridge port, and exit before we can become a billing zombie.
    if bridge_port is None:
        log.error("No *_TCP_PORT_8899 mapped by the provider — the hub can never bridge to "
                  "this GPU. Reporting failed so the broker re-races.")
        _post_failed("no 8899 bridge port mapped")
        sys.exit(1)

    # GPU sanity gate — a GPU-blind host must fail fast so the broker re-races across
    # providers (this is the role that genuinely needs NVENC/NVDEC; vps skips it).
    ok, reason = _gpu_self_test()
    if not ok:
        drv = _driver_version()
        log.error("GPU self-test FAILED (driver %s): %s. Reporting failed.", drv, reason)
        _post_failed(f"{reason} (driver {drv})")
        sys.exit(1)

    _gen_self_signed_cert()

    # Report readiness early (the bridge address is known from env at boot). Then:
    #  • None  → the control plane never confirmed our CAS (5 lost POSTs). A GPU backend is
    #    useless to the hub until readiness is recorded (the hub gates the bridge on
    #    phase='ready'), so we must NOT "assume winner" and heartbeat — that path bills the
    #    whole session while no reaper catches it. Report failed + exit so the broker
    #    re-races; exiting leaves last_seen null so the never-paired sweep replaces us. (The
    #    old "assume winner" optimism was inherited from the deleted all-in-one pod, which
    #    could serve OBS without the control plane; a backend cannot.)
    #  • winner=false → another racer won this node; exit quietly.
    ready = _post_ready_gpu(ip, bridge_port)
    if ready is None:
        log.error("Readiness CAS unconfirmed with the control plane — exiting so the broker re-races.")
        _post_failed("ready CAS unconfirmed")
        sys.exit(1)
    if not ready.get("winner", True):
        log.info("Lost gpu race (another GPU won) — exiting.")
        sys.exit(0)

    # The transcode reads the source from the VPS source_forward (which connects in).
    # One Supervisor; one transcode runner (one decode → N orientation encodes → N RTMPS
    # returns).
    if BRIDGE_AUTH:
        # SEC-03: the bridge_proxy gateway owns the PUBLIC :8899 — it terminates TLS and
        # validates the SLIMCAST_BRIDGE_SECRET preamble, then splices to ffmpeg on a PRIVATE
        # localhost port. ffmpeg never sees an unauthenticated peer, so a stranger who finds
        # the GPU IP:8899 can no longer inject mpegts into the victim's outputs. Default-off
        # (SLIMCAST_BRIDGE_AUTH unset) keeps the proven baseline below byte-identical.
        bridge_gw = _start_bridge_gateway()
        listen = f"tcp://127.0.0.1:{BRIDGE_BACKEND_PORT}?listen=1"
        log.info("SEC-03 bridge auth ENABLED — ffmpeg reads plaintext from the gateway on :%d",
                 BRIDGE_BACKEND_PORT)
    else:
        bridge_gw = None
        # Baseline: ffmpeg terminates the public TLS itself. NOTE: the cert is injected as
        # -cert_file/-key_file INPUT OPTIONS by supervisor._input_args() — ffmpeg's tls server
        # ignores cert_file/key_file passed as URL query params ("no shared cipher" handshake
        # failure). Do NOT put them here.
        listen = "tls://0.0.0.0:8899?listen=1"
    sup = Supervisor(source=listen, role="gpu")

    def shutdown(sig: int, _frame: object) -> None:
        log.info("Received signal %d — gpu shutting down…", sig)
        sup.stop_all()
        sys.exit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    last_hash: "str | None" = None
    hb_failures = 0
    # The GPU backend only talks to the VPS (mpegts-over-TLS source IN, RTMPS H.264 OUT),
    # so /proc/net/dev IS the internal VPS↔GPU bridge leg. Measure it for dock telemetry.
    cost_meter = CostMeter()
    while True:
        # Self-heal the auth gateway: if it ever exits, the bridge goes dark while this GPU
        # keeps heartbeating "healthy" (so no reaper re-races it) → a silent transcode outage.
        # Restart it (fail-closed → self-healing). bridge_gw is None when auth is off.
        if bridge_gw is not None and bridge_gw.poll() is not None:
            log.error("bridge_proxy gateway exited (code %s) — restarting", bridge_gw.returncode)
            bridge_gw = _start_bridge_gateway()
        cfg_resp = _api("GET", "/api/agent/gpu-config") or {}
        groups = cfg_resp.get("groups", [])
        returns = cfg_resp.get("return")
        cfg = {
            "groups": groups,
            "return": returns,
            "crop": cfg_resp.get("crop", {}),
            "source_width": cfg_resp.get("source_width"),
            "source_height": cfg_resp.get("source_height"),
        }
        new_hash = json.dumps(cfg, sort_keys=True)
        if groups and returns:
            if new_hash != last_hash:
                log.info("gpu-config: %d group(s) — (re)applying transcode.", len(groups))
                sup.apply(cfg)
                last_hash = new_hash
        elif last_hash is not None:
            log.info("gpu-config empty — stopping transcode.")
            sup.stop_all()
            last_hash = None

        # Bridge telemetry → the dock's "GPU bridge" health series. GB/hr → kbps is
        # *1e9*8/3600/1000 ≈ *2222.22. egress = the H.264 returned to the VPS (the
        # meaningful delivered bitrate); active = a transcode is currently applied.
        # Carry the bridge address on every beat so the control plane can self-heal a lost
        # /ready: if our readiness POST was dropped at the edge, status/route.ts re-runs the
        # idempotent winner-CAS from this and promotes us racing→ready (else we'd be stuck
        # 'racing' forever — billing, un-reaped, hub never bridging). bridge_port is
        # guaranteed non-None here (we exit above if it was).
        hb_body: dict = {"role": "gpu", "ip": ip, "bridge_port": bridge_port, "provider_id": PROVIDER_ID}
        cost = cost_meter.sample()
        if cost is not None:
            hb_body["bridge"] = {
                "ingress_kbps": round(cost["ingress_gb_hr"] * 2222.22),
                "egress_kbps": round(cost["egress_gb_hr"] * 2222.22),
                "active": last_hash is not None,
            }
        hb = _api("POST", "/api/agent/status", hb_body)
        hb_failures = 0 if hb is not None else hb_failures + 1
        if hb_failures >= HEARTBEAT_FAIL_LIMIT:
            log.error("No control-plane contact (%d beats) — gpu stopping outputs (safety).", hb_failures)
            sup.stop_all()
            last_hash = None
        time.sleep(POLL_INTERVAL)


def main() -> None:
    if RELAY_ROLE == "vps":
        main_vps()
    elif RELAY_ROLE == "gpu":
        main_gpu()
    else:
        raise RuntimeError(f"unknown RELAY_ROLE={RELAY_ROLE!r} — the all-in-one role was removed")


if __name__ == "__main__":
    main()

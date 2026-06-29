"""
supervisor.py — builds and manages the FFmpeg processes for the SlimCast relay.

There is ONE path from OBS to a GPU: OBS -> SRT -> trusted VPS hub -> mpegts-over-TLS
bridge -> GPU backend (HEVC decode -> H.264 encode) -> RTMPS return to the hub -> the
hub fans out to the platforms. Stream keys never reach the GPU. Two roles share this
file (selected per process by RELAY_ROLE):

  gpu (RELAY_ROLE=gpu) — GPU backend. One mpegts-over-TLS input from the hub -> NVDEC
      decode -> one NVENC H.264 encode PER ORIENTATION -> one RTMPS return per
      orientation to the hub. A single ffmpeg (one decode, N encodes); the hub owns the
      platform tee. See build_gpu_transcode_cmd.

  vps (RELAY_ROLE=vps) — card-less trusted hub, one Supervisor per tenant. Builds:
      passthrough (HEVC `-c copy` -> YouTube HLS) and ertmp (HEVC -> Twitch Enhanced
      RTMP) directly from the tenant feed (no NVENC on the hub); plus, when the tenant
      has a GPU backend, source_forward (push the tenant HEVC to the GPU bridge) and
      deliver (tee the GPU's H.264 return to every transcode platform). See
      build_passthrough_cmd, build_ertmp_cmd, build_source_forward_cmd, build_deliver_cmd.

Each runner runs in its own thread, captures FFmpeg stderr into a ring buffer, and
auto-restarts with exponential backoff while it is supposed to be running.
"""

from __future__ import annotations

import collections
import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG_PATH = os.environ.get("RELAY_CONFIG", "config.json")
# Loopback feed republished by MediaMTX. We pull over SRT (MPEG-TS), NOT RTSP:
# RTSP/RTP mangles Apple's temporal-layered HEVC ("Illegal temporal ID" →
# dropped frames / artifacts). SRT carries HEVC cleanly.
# Note: MediaMTX <v1.15.0 had a DTS extractor bug with Apple VT HEVC that closed
# SRT connections ("DTS is not monotonically increasing"). Fixed in v1.15.0
# (issue #4892). Dockerfile pins MediaMTX to v1.19.1+ which includes this fix.
LOCAL_SOURCE = os.environ.get(
    "RELAY_SOURCE", "srt://127.0.0.1:8890?streamid=read:live"
)

# Self-signed cert for the VPS-hub GPU bridge's mpegts-over-TLS listener (RELAY_ROLE=gpu),
# generated at boot by agent.py._gen_self_signed_cert(). Same paths MediaMTX uses for the
# hub's RTMPS return server.
TLS_CERT_FILE = "/app/relay.crt"
TLS_KEY_FILE = "/app/relay.key"

LOG_LINES = 250
RESTART_MIN = 2.0      # seconds
RESTART_MAX = 30.0     # seconds
# Crash-loop detection: a process that keeps dying within seconds is broken (bad
# codec/flag/host), not just disconnected. After this many consecutive fast exits
# the runner flips to a clear 'error' state (surfaced in status()/heartbeat/panel)
# instead of masquerading as 'restarting' forever — so a real failure is visible
# rather than looking like an endless "connecting".
CRASH_LOOP_THRESHOLD = 5
CRASH_LOOP_MIN_RUNTIME = 15.0   # an exit sooner than this counts as a crash, not a clean disconnect

# ---- secret redaction ----------------------------------------------------
# Stream keys end up embedded in the FFmpeg command (rtmp://host/app/<KEY>) and
# in FFmpeg's own "Output #0 ... to '<url>'" banner. Both flow into the in-memory
# log ring buffer, which the debug panel can surface — so a key must never be
# written there verbatim. We keep a live set of the actual key strings (refreshed
# on every apply) and literal-replace them in every log line. Literal replacement
# is exact: no regex guesswork, no over-redaction of harmless path segments.
_SECRETS: set[str] = set()


# ---- eRTMP session cache -------------------------------------------------
# GetClientConfiguration returns a per-session auth token valid ~48h. Cache it
# so plan_runners() can call _resolve_ertmp_url() on every apply() (every 10s)
# without hammering the Twitch API. Cleared by Supervisor.stop_all() so each
# new stream start gets a fresh session.
_ertmp_session_cache: dict[str, str] = {}  # stream_key -> resolved_url
_ertmp_cache_lock = threading.Lock()


# Fixed GPU identity reported to Twitch Enhanced Broadcasting's
# GetClientConfiguration. Twitch gates eRTMP/HEVC ingest on the GPU declared in
# the JSON body — and it CANNOT verify the hardware (the call is stateless
# JSON→JSON). Reporting the real Vast.ai GPU fails because Vast hands out random
# consumer cards, many of which aren't on Twitch's allowlist ("Your GPU is not
# currently supported"). Since the Twitch path is pure HEVC passthrough (`-c
# copy` — the pod never encodes), the GPU we claim is irrelevant to operation;
# it only has to clear the allowlist. So we always claim a fixed, known-good
# card. This also makes the path work on a GPU-less CPU VPS (the cheap tier for
# Twitch+YouTube-only users), where nvidia-smi doesn't even exist.
#
# vendor_id 4318 (0x10DE) is NVIDIA — the field Twitch's allowlist keys on.
# device_id 9860 (0x2684) is the real AD102 die, self-consistent with the RTX
# 4090 model string so we survive any future device_id↔model cross-check. The
# RTX 4090 is unambiguously allowlisted and HEVC-capable, and high-end enough
# that Twitch won't quietly drop it.
#
# Proven fallback if the 4090 identity is ever rejected (community-verified):
#   {"model": "GeForce RTX 3080", "vendor_id": 4318, "device_id": 8711,
#    "dedicated_video_memory": 10737418240, "shared_system_memory": 0,
#    "driver_version": "32.0.15.6094"}
SPOOF_GPU = {
    "model": "NVIDIA GeForce RTX 4090",
    "vendor_id": 4318,                       # 0x10DE NVIDIA
    "device_id": 9860,                       # 0x2684 AD102 (real RTX 4090 die)
    "dedicated_video_memory": 24 * 1024 ** 3,  # 24 GiB
    "shared_system_memory": 16 * 1024 ** 3,
    "driver_version": "32.0.15.6094",
}

# Twitch/IVS accepts only these integer framerates; anything else is rejected at
# config time ("Your frame rate 59.94 is not supported…"). Snap to the nearest.
_SUPPORTED_FPS = (24, 25, 30, 48, 50, 60)


def _snap_fps(fps: float) -> int:
    return min(_SUPPORTED_FPS, key=lambda s: abs(s - fps))


def _resolve_ertmp_url(out: dict) -> str:
    """Call Twitch GetClientConfiguration to get a session ingest URL + auth token.

    Twitch's Enhanced Broadcasting endpoint requires a per-session authentication
    token in place of the raw stream key. The token encodes the negotiated quality
    config and is verified by the ingest server — using the raw key causes exit 187.
    """
    stream_key = out.get("key", "").strip()
    with _ertmp_cache_lock:
        if stream_key in _ertmp_session_cache:
            return _ertmp_session_cache[stream_key]

    # We pass the source HEVC straight through (no scaling on the Twitch path),
    # so the canvas we report is the real source resolution. SOURCE_WIDTH/HEIGHT
    # are injected per-pod at provision from the user's max output resolution, so
    # this is already per-user dynamic. Framerate is snapped to a Twitch-supported
    # integer (it rejects 59.94 etc. at config time).
    fps = _snap_fps(float(out.get("fps") or 60))

    body = {
        "service": "IVS",
        "schema_version": "2025-01-25",
        "authentication": stream_key,
        "capabilities": {
            # CPU/memory are plausible-but-fake; Twitch does not sanity-check them
            # (the community method passes with 1 core / 102 MiB). Kept realistic
            # as cheap consistency hardening against a future heuristic.
            "cpu": {"physical_cores": 8, "logical_cores": 16, "speed": 3600,
                    "name": "Intel Core i9-13900K"},
            "memory": {"total": 32 * 1024 ** 3, "free": 16 * 1024 ** 3},
            "gaming_features": None,
            # Enhanced Broadcasting is officially Windows-only; claim Windows so
            # the OS never contributes to a rejection (defense-in-depth — our
            # earlier Ubuntu body still returned a config_id, so OS isn't strictly
            # gated today, but a fake NVIDIA card on Windows is the consistent pair).
            "system": {
                "version": "10.0.22631", "name": "Windows",
                "build": 22631, "release": "23H2", "revision": "",
                "bits": 64, "arm": False, "armEmulation": False,
            },
            "gpu": [dict(SPOOF_GPU)],
        },
        "client": {
            "name": "obs-studio",
            "version": "32.0.4",   # OBS release that ships schema_version 2025-01-25
            # Only declare h265 — listing h264 too risks Twitch negotiating H.264
            # and then disconnecting when we send HEVC (codec mismatch).
            "supported_codecs": ["h265"],
        },
        "preferences": {
            "vod_track_audio": False,
            "composition_gpu_index": 0,    # references gpu[0] above — must be non-empty
            "canvases": [{
                "width": SOURCE_WIDTH, "height": SOURCE_HEIGHT,
                "canvas_width": SOURCE_WIDTH, "canvas_height": SOURCE_HEIGHT,
                "framerate": {"numerator": fps, "denominator": 1},
            }],
            "audio_samples_per_sec": 48000,
            "audio_channels": 2,
            "audio_fixed_buffering": False,
            "audio_max_buffering_ms": 20,
            "maximum_video_tracks": 1,
        },
    }

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://ingest.twitch.tv/api/v3/GetClientConfiguration",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        config = json.loads(resp.read())

    # Log the negotiated codec/tracks so we can diagnose mismatches.
    enc_cfgs = config.get("encoder_configurations", [])
    codecs = [c.get("codec") or c.get("type", "?") for c in enc_cfgs]
    resolutions = [f"{c.get('width')}x{c.get('height')}" for c in enc_cfgs]
    print(f"[ertmp] GetClientConfiguration: {len(enc_cfgs)} track(s), codecs={codecs}, res={resolutions}", flush=True)

    # Fail loudly on a config-time rejection (GPU/key/framerate) so the caller's
    # fallback fires instead of silently building a URL from a missing endpoint.
    # The live Twitch API returns the message under `html`; OBS's struct calls it
    # `html_en_us` — read both.
    status = config.get("status", {}) or {}
    if status:
        print(f"[ertmp] status: {status}", flush=True)
    if status.get("result") == "error":
        msg = status.get("html") or status.get("html_en_us") or status
        raise ValueError(f"GetClientConfiguration rejected: {msg}")

    endpoints = config.get("ingest_endpoints", [])
    endpoint = next((e for e in endpoints if e.get("protocol") == "RTMPS"), None)
    if endpoint is None and endpoints:
        endpoint = endpoints[0]
    if not endpoint:
        raise ValueError(f"GetClientConfiguration returned no endpoints")

    session_key = endpoint["authentication"]
    url_template = endpoint["url_template"]
    config_id = config.get("meta", {}).get("config_id", "")

    resolved = url_template.replace("{stream_key}", session_key)
    if config_id:
        resolved += f"?clientConfigId={config_id}"

    # Redact the session token just like we redact stream keys.
    if len(session_key) >= 4:
        _SECRETS.add(session_key)

    with _ertmp_cache_lock:
        _ertmp_session_cache[stream_key] = resolved
    return resolved


def _register_secrets(cfg: dict, source: str = "") -> None:
    """Collect every secret from the live config + source so _redact can scrub them."""
    # The ingest key AND the SRT passphrase both appear verbatim in the loopback
    # source URL embedded in each runner cmd. Parse them from the per-tenant source
    # (multi-tenant: the env SLIMCAST_INGEST_KEY is only tenant-zero) so every
    # tenant's key + the SRT passphrase are redacted, not just one (review #6/#7).
    if source:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(source).query)
        sid = (q.get("streamid", [""])[0] or "")
        if ":" in sid:
            k = sid.split(":", 1)[1].strip()
            if len(k) >= 4:
                _SECRETS.add(k)
        pp = (q.get("passphrase", [""])[0] or "").strip()
        if len(pp) >= 4:
            _SECRETS.add(pp)
    # Backward-compat: the env ingest key (all-in-one) + the SRT passphrase env.
    ingest = os.environ.get("SLIMCAST_INGEST_KEY", "").strip()
    if len(ingest) >= 4:
        _SECRETS.add(ingest)
    srt_pp = os.environ.get("SLIMCAST_SRT_PASSPHRASE", "").strip()
    if len(srt_pp) >= 4:
        _SECRETS.add(srt_pp)
    def _add_output_secrets(o: dict) -> None:
        key = (o.get("key") or "").strip()
        if len(key) >= 4:
            _SECRETS.add(key)
        # YouTube HLS passthrough carries the key as the cid= query param.
        url = o.get("url") or ""
        if "cid=" in url:
            cid = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("cid", [""])[0]
            if len(cid) >= 4:
                _SECRETS.add(cid)

    for o in cfg.get("outputs", []):
        _add_output_secrets(o)
    # VPS-hub transcode tenant: the DECRYPTED platform keys (Kick/TikTok/non-eligible
    # Twitch H.264) ride in bridge.return_outputs[].targets[], NOT cfg["outputs"] (which
    # holds only passthrough/ertmp on the hub). Without scrubbing these, build_deliver_cmd
    # embeds them in the runner argv that OutputRunner logs verbatim → plaintext key leak
    # the moment the :8080 debug panel is enabled on a hub.
    bridge = cfg.get("bridge") or {}
    for ro in bridge.get("return_outputs", []):
        for t in ro.get("targets", []):
            _add_output_secrets(t)


def _redact(msg: str) -> str:
    # Snapshot the set: it's a module global mutated by apply()/_resolve_ertmp_url on
    # other threads while N runner threads call _redact, and iterating a set being
    # mutated raises "Set changed size during iteration" (review: _SECRETS race).
    for s in tuple(_SECRETS):
        msg = msg.replace(s, "***")
    return msg


# GPU backend pods AND vps hubs have NO remote log surface (no :8080 panel — only the
# all-in-one role runs it), so an ffmpeg that fails to bind/transcode is invisible: its
# stderr is buffered in the runner, never reaching `docker logs`/`vastai logs`. On the GPU
# role and the vps hub role, mirror ffmpeg stderr to stdout (redacted) so the
# passthrough/bridge is debuggable. Safe: every platform stream key (incl. the YouTube HLS
# `cid`) + SRT passphrase is registered in _SECRETS and scrubbed by _redact above.
_FFMPEG_STDERR_TO_STDOUT = os.environ.get("RELAY_ROLE", "") in ("gpu", "vps")


def _input_args(source: str) -> list[str]:
    """Per-protocol input flags."""
    if source.startswith("rtsp"):
        return ["-rtsp_transport", "tcp"]
    if source.startswith("srt"):
        return ["-fflags", "+genpts"]
    if source.startswith("tls"):
        # VPS-hub GPU bridge: the VPS pushes mpegts-over-TLS to the GPU's raw listener.
        # Declare mpegts explicitly (a raw TLS byte stream has no container hint), and
        # +igndts because DTS is unreliable after the VPS's `-c copy` mpegts re-mux
        # (see bpm_inject.py); the bumped probe lets NVDEC see the HEVC SPS/PPS first.
        args = ["-f", "mpegts", "-fflags", "+genpts+igndts", "-analyzeduration", "10M", "-probesize", "10M"]
        # TLS SERVER (listen=1): ffmpeg's tls protocol does NOT load cert_file/key_file
        # when they're given as URL query params — the server then offers no certificate
        # and every handshake dies with "no shared cipher" (the GPU's :8899 transcode
        # ffmpeg exits → crash-loop → the hub's source_forward sees "connection refused").
        # The cert MUST be passed as INPUT OPTIONS instead. Verified on jellyfin-ffmpeg
        # 7.1.4-3: URL-query cert → handshake fails; -cert_file/-key_file input opts → OK.
        if "listen=1" in source:
            args = ["-cert_file", TLS_CERT_FILE, "-key_file", TLS_KEY_FILE] + args
        return args
    return []


def load_config(path: str = CONFIG_PATH) -> dict:
    with open(path) as f:
        return json.load(f)


def save_config(cfg: dict, path: str = CONFIG_PATH) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)


def _full_rtmp_url(out: dict) -> str:
    """Join base url + stream key, tolerating trailing slashes / embedded keys."""
    url = out.get("url", "").strip()
    key = out.get("key", "").strip()
    if not key:
        return url
    return url.rstrip("/") + "/" + key


# Source resolution (must match OBS output — used for crop math).
SOURCE_WIDTH = int(os.environ.get("SOURCE_WIDTH", "1920"))
SOURCE_HEIGHT = int(os.environ.get("SOURCE_HEIGHT", "1080"))

# Portrait output canvas (9:16).
PORTRAIT_WIDTH = 1080
PORTRAIT_HEIGHT = 1920

def _even(n: int) -> int:
    """NVENC requires even dimensions."""
    n = int(n)
    return n - (n % 2)


def portrait_crop_rect(crop: dict | None, src_w: int = SOURCE_WIDTH, src_h: int = SOURCE_HEIGHT) -> tuple[int, int, int, int]:
    """
    Translate the user's framing controls into an FFmpeg crop rectangle.

    User-facing controls (stored per account on slimcast.com):
      zoom  >= 1.0  : 1.0 uses the full source height; higher zooms in (tighter).
      pos_x 0..1    : horizontal position of the crop window (0 left, .5 center, 1 right).
      pos_y 0..1    : vertical position of the crop window (0 top, .5 center, 1 bottom).

    src_w/src_h default to the module SOURCE_WIDTH/HEIGHT (all-in-one path) but are
    passed explicitly by the GPU bridge role, where the source res is per-tenant (from
    gpu-config) rather than a process-wide env.

    Returns (w, h, x, y) for FFmpeg `crop=w:h:x:y`, clamped to the source frame and
    snapped to even pixels. The window is always 9:16 so it scales cleanly to 1080×1920.
    """
    crop = crop or {}
    zoom = max(1.0, float(crop.get("zoom", 1.0)))
    pos_x = min(1.0, max(0.0, float(crop.get("pos_x", 0.5))))
    pos_y = min(1.0, max(0.0, float(crop.get("pos_y", 0.5))))

    # Tallest possible 9:16 window at this zoom, bounded by source height.
    ch = src_h / zoom
    cw = ch * PORTRAIT_WIDTH / PORTRAIT_HEIGHT  # ch * 9/16

    # If the window is wider than the source, clamp width and re-derive height.
    if cw > src_w:
        cw = src_w
        ch = cw * PORTRAIT_HEIGHT / PORTRAIT_WIDTH  # cw * 16/9

    cw, ch = _even(cw), _even(ch)
    cx = _even((src_w - cw) * pos_x)
    cy = _even((src_h - ch) * pos_y)
    return cw, ch, cx, cy


def _encode_flags(bv: int, fps: int) -> list[str]:
    """Shared NVENC H.264 quality ladder + AAC audio. Do not degrade these."""
    bufsize = bv * 2  # 2x target: gives NVENC room to allocate bits across scenes
    gop = fps * 2     # 2-second keyframe interval (platform requirement)
    return [
        "-c:v", "h264_nvenc",
        "-preset", "p7", "-tune", "hq", "-multipass", "fullres",
        "-rc", "cbr", "-b:v", f"{bv}k", "-maxrate", f"{bv}k", "-bufsize", f"{bufsize}k",
        "-profile:v", "high", "-g", str(gop), "-forced-idr", "1",
        "-bf", "2", "-b_ref_mode", "middle", "-rc-lookahead", "32",
        "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    ]


# Characters that would let a stream key/URL break out of the FFmpeg `tee` target
# string and inject an extra destination ("...|[f=flv]rtmp://attacker/...") or a
# local file sink ("[f=mp4]/tmp/x"). Real RTMP/stream keys are URL-safe and never
# contain these, so any output carrying one is malformed or hostile — we drop it
# rather than fan the user's stream out to an attacker-controlled target. The
# PRIMARY guard is web-side validation on save (POST /api/platforms); this is the
# pod's defense-in-depth so a bad key can never reach the tee muxer.
_TEE_UNSAFE = ("|", "[", "]", "\n", "\r", " ", "\t", "\\")


def _tee_safe(url: str) -> bool:
    return not any(c in url for c in _TEE_UNSAFE)


def _tee_targets(outputs: list[dict]) -> str:
    """Build the FFmpeg `tee` output string. onfail=ignore keeps the shared
    encode alive when a single platform's ingest drops or rejects the stream.
    Targets whose URL/key contain tee control characters are skipped (injection
    guard) — a real key never has them."""
    parts = []
    for o in outputs:
        url = _full_rtmp_url(o)
        if not _tee_safe(url):
            continue
        parts.append(f"[f=flv:onfail=ignore:use_fifo=1:fifo_options=queue_size=512,drop_pkts_on_overflow=1]{url}")
    return "|".join(parts)


_RES_HEIGHT = {"720p": 720, "1080p": 1080, "1440p": 1440}


def build_passthrough_cmd(out: dict, source: str = LOCAL_SOURCE) -> list[str]:
    """HEVC copy -> HLS PUT to YouTube's HLS ingest URL (no re-encode).

    YouTube ingests HEVC only over HLS (its RTMP endpoint is H.264-only), and its
    HLS ingestion requires **MPEG-2 Transport Stream (.ts)** segments. Fragmented MP4
    (CMAF) is NOT supported — YouTube 200-OKs every fMP4 PUT but silently drops the
    media, so Studio shows "No data" forever regardless of the stream key. HEVC rides
    in TS via PMT stream_type 0x24; there is no init segment and no fourcc tag.
    `-c copy` passes the source HEVC video + AAC audio straight through untouched, so
    YouTube gets full source quality with zero GPU encode cost.

    Verified live 2026-06-29 (HEVC test pattern -> real stream key -> Studio went live).
    Do NOT switch back to fmp4/CMAF — that was the long-standing "YouTube dark" bug
    (the old comment here claimed TS was "H.264-only", which is wrong per YouTube's
    docs). TS carries AAC as ADTS natively, so NO `aac_adtstoasc` filter (that's an
    fMP4-ism that breaks TS); NO `-tag:v hvc1` (an MP4 fourcc — ffmpeg's "Stream HEVC
    is not hvc1" warning is cosmetic for TS). Segment duration must stay <=5s, so the
    OBS source must use a keyframe interval <= hls_time (2s) for clean GOP-aligned
    `-c copy` segments. Ref: developers.google.com/youtube/v3/live/guides/hls-ingestion
    """
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        *_input_args(source),
        "-i", source,
        "-c", "copy",
        "-f", "hls",
        "-method", "PUT",
        "-http_persistent", "1",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_segment_type", "mpegts",
        "-hls_flags", "delete_segments+omit_endlist+independent_segments",
        out["url"],
    ]


def build_ertmp_cmd(out: dict, source: str = LOCAL_SOURCE) -> list[str]:
    """HEVC copy -> Enhanced RTMP (eRTMP) for Twitch, with BPM SEI injection.

    Twitch Enhanced Broadcasting requires two things beyond a plain HEVC push:
      1. A per-session ingest URL + auth token from GetClientConfiguration
         (_resolve_ertmp_url; using the raw key disconnects with exit 187).
      2. Broadcast Performance Metrics (BPM) SEI on every IDR, or Twitch drops the
         connection a few seconds in. A raw `-c copy` of Apple VT HEVC has none, so
         bpm_inject.py appends them at the bitstream level (no re-encode).

    Pipeline: jellyfin-ffmpeg reads the SRT loopback and re-muxes to MPEG-TS; the
    injector appends BPM SEI to each keyframe; jellyfin-ffmpeg muxes the result to
    the eRTMP endpoint. ffmpeg owns the network I/O (SRT in, eRTMP out — both
    proven), so PyAV only ever touches pipe+mpegts. `pipefail` makes any stage's
    failure exit the pipeline so OutputRunner restarts it; the runner starts the
    whole pipeline in its own process group and kills the group on stop.
    """
    try:
        ingest_url = _resolve_ertmp_url(out)
    except Exception as exc:
        # Log and fall back to the configured URL so the runner starts and logs the error.
        ingest_url = _full_rtmp_url(out)
        print(f"[ertmp] GetClientConfiguration failed ({exc}); using raw URL (will likely fail)", flush=True)
    in_flags = " ".join(_input_args(source))
    pipeline = (
        "set -o pipefail; "
        f"ffmpeg -hide_banner -loglevel error {in_flags} -i '{source}' "
        "-c copy -f mpegts pipe:1 "
        "| python3 /app/bpm_inject.py "
        "| ffmpeg -hide_banner -loglevel verbose -i pipe:0 "
        "-c copy -f flv -flvflags no_duration_filesize "
        # Declare HEVC in the enhanced-RTMP connect handshake (writes the
        # `fourCcList` AMF field). Without this ffmpeg connects as LEGACY rtmp and
        # Twitch drops the HEVC stream ~2s in with no error — the client never
        # announced enhanced-codec capability at connect time.
        "-rtmp_enhanced_codecs hvc1 "
        f"'{ingest_url}'"
    )
    return ["bash", "-c", pipeline]


def build_gpu_transcode_cmd(
    source: str,
    groups: list[dict],
    returns: dict,
    crop: dict | None = None,
    src_w: int = SOURCE_WIDTH,
    src_h: int = SOURCE_HEIGHT,
) -> list[str]:
    """GPU BACKEND (RELAY_ROLE=gpu): one mpegts-over-TLS input → NVDEC decode → one
    NVENC H.264 encode PER ORIENTATION → one RTMPS return per orientation to the VPS.

    A SINGLE ffmpeg (one decode, N encodes), NOT one process per orientation: the
    source arrives once on the TLS listener, which only one process can bind. The VPS
    fans each return out to its platforms (the `tee` lives on the VPS deliver runner,
    not here). `returns` = { '<orientation>_url': 'rtmps://<vps>:1936/return/<key>/<o>' }
    (the protocol is whatever gpu-config provides, so an RTMPS→RTMP fallback is config-
    only). Reuses the proven _encode_flags ladder unchanged; AAC audio rides each return
    so the VPS deliver can `-c copy`.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
        *_input_args(source),
        "-i", source,
    ]
    for g in groups:
        orientation = g.get("orientation", "landscape")
        url = returns.get(f"{orientation}_url")
        if not url:
            continue
        bv = int(g.get("bitrate_kbps", 6000))
        fps = int(g.get("fps", 60))
        max_h = _RES_HEIGHT.get(g.get("resolution") or "", src_h)
        cmd += ["-map", "0:v", "-map", "0:a"]
        if orientation == "portrait":
            cw, ch, cx, cy = portrait_crop_rect(crop, src_w, src_h)
            pw, ph = (720, 1280) if max_h <= 720 else (PORTRAIT_WIDTH, PORTRAIT_HEIGHT)
            cmd += ["-vf", f"hwdownload,format=nv12,crop={cw}:{ch}:{cx}:{cy},scale={pw}:{ph}"]
        elif max_h < src_h:
            cmd += ["-vf", f"scale_cuda=-2:{max_h}"]
        cmd += _encode_flags(bv, fps)
        cmd += ["-flush_packets", "1", "-f", "flv", url]
    return cmd


def build_source_forward_cmd(source: str, dest: str) -> list[str]:
    """VPS → GPU bridge (RELAY_ROLE=vps, transcode tenant): read the tenant's SRT
    loopback HEVC and push it to the GPU's mpegts-over-TLS listener with `-c copy` (no
    re-encode → temporal HEVC preserved). The card-less hub does no NVENC; the GPU does."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        *_input_args(source),
        "-i", source,
        "-c", "copy", "-f", "mpegts", dest,
    ]


def build_deliver_cmd(return_url: str, targets: list[dict]) -> list[str]:
    """VPS deliver (RELAY_ROLE=vps, transcode tenant): read the GPU's H.264 return from
    the LOCAL MediaMTX and tee (`-c copy`, the GPU already encoded) to every transcode
    platform for this orientation. The tee + use_fifo backpressure decoupling lives HERE
    (the GPU returned ONE stream; the platform fan-out is the VPS's job)."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-i", return_url,
        "-map", "0:v", "-map", "0:a", "-c", "copy",
        "-flush_packets", "1", "-f", "tee", _tee_targets(targets),
    ]


class OutputRunner:
    """Supervises a single FFmpeg process (one passthrough output or one group)."""

    def __init__(self, key: str, cmd: list[str], platforms: list[str] | None = None,
                 mode: str = "transcode"):
        self.key = key
        self.name = key
        self.cmd = cmd
        self.platforms = platforms or []
        self.mode = mode
        self._proc: subprocess.Popen | None = None
        # Serializes _run_loop's spawn (read _stop → Popen → assign _proc) against
        # stop()/_kill_proc reading _proc, so a stop landing in the spawn window can't
        # miss the just-created process and leak an orphan ffmpeg (review: stop/Popen race).
        self._proc_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._logs: collections.deque[str] = collections.deque(maxlen=LOG_LINES)
        self.state = "stopped"   # stopped | running | restarting | error
        self.restarts = 0
        self.fast_exits = 0      # consecutive sub-CRASH_LOOP_MIN_RUNTIME exits
        self.last_exit: int | None = None

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._kill_proc()

    def _kill_proc(self) -> None:
        # Read _proc under the lock so we observe a spawn that _run_loop may be doing
        # right now (the lock pairs with the spawn block in _run_loop). The slow kill
        # itself runs outside the lock so we don't block the spawn for ~5s.
        with self._proc_lock:
            p = self._proc
        if not p or p.poll() is not None:
            return
        # Each runner starts in its own session/process group (start_new_session),
        # so kill the whole group — this reaps the eRTMP runner's 3-stage pipeline
        # (two ffmpegs + the injector), not just the bash leader. Single-process
        # runners have only one member, so the behaviour is unchanged for them.
        try:
            pgid = os.getpgid(p.pid)
        except Exception:
            pgid = None
        try:
            if pgid is not None:
                os.killpg(pgid, signal.SIGTERM)
            else:
                p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if pgid is not None:
                    os.killpg(pgid, signal.SIGKILL)
                else:
                    p.kill()
        except Exception:
            pass

    # ---- run loop --------------------------------------------------------
    def _run_loop(self) -> None:
        backoff = RESTART_MIN
        while not self._stop.is_set():
            self._log(f"$ {' '.join(self.cmd)}")
            # Spawn under the lock with a final _stop check: if stop() already fired,
            # do NOT spawn (else we'd leak an orphan the kill already missed). _proc is
            # assigned under the lock so a concurrent _kill_proc sees this process.
            with self._proc_lock:
                if self._stop.is_set():
                    break
                try:
                    self._proc = subprocess.Popen(
                        self.cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        text=True,
                        errors="replace",   # a non-UTF-8 stderr byte must not kill the thread
                        bufsize=1,
                        start_new_session=True,   # own process group → clean group kill
                    )
                except FileNotFoundError:
                    self.state = "error"
                    self._log("ERROR: ffmpeg not found on PATH")
                    return

            # A stop that landed right after the lock released still kills this proc:
            # _kill_proc reads _proc (now set) under the lock. Re-check so we tear down
            # immediately instead of blocking in the stderr drain on a live process.
            if self._stop.is_set():
                self._kill_proc()
                break

            self.state = "running"
            started = time.time()
            assert self._proc.stderr is not None
            for line in self._proc.stderr:
                txt = line.rstrip()
                self._log(txt)
                if _FFMPEG_STDERR_TO_STDOUT:
                    print(f"[ffmpeg:{self.name}] {_redact(txt)}", flush=True)

            self.last_exit = self._proc.wait()
            ran_for = time.time() - started

            if self._stop.is_set():
                self.state = "stopped"
                self._log("stopped")
                return

            # crashed/disconnected -> back off and retry
            self.restarts += 1
            # A healthy run (>=60s) resets both the crash counter and the backoff.
            # A sub-CRASH_LOOP_MIN_RUNTIME exit is a "fast" (crash) exit; count it.
            if ran_for >= 60:
                self.fast_exits = 0
                backoff = RESTART_MIN
            else:
                if ran_for < CRASH_LOOP_MIN_RUNTIME:
                    self.fast_exits += 1
                backoff = min(backoff * 2, RESTART_MAX)

            # Once we've crash-looped past the threshold, surface a clear 'error'
            # state (and one loud log line) instead of an endless 'restarting' —
            # but keep retrying so a transient host/codec hiccup can still recover.
            if self.fast_exits >= CRASH_LOOP_THRESHOLD:
                if self.state != "error":
                    self._log(f"CRASH-LOOP: exited (code {self.last_exit}) "
                              f"{self.fast_exits}x in a row, each <{CRASH_LOOP_MIN_RUNTIME:.0f}s "
                              f"— pipeline is broken; see the FFmpeg lines above.")
                self.state = "error"
            else:
                self.state = "restarting"

            self._log(f"exited (code {self.last_exit}) after {ran_for:.0f}s; "
                      f"retry in {backoff:.0f}s")
            self._stop.wait(backoff)

        self.state = "stopped"

    # ---- helpers ---------------------------------------------------------
    def _log(self, msg: str) -> None:
        self._logs.append(f"{time.strftime('%H:%M:%S')} {_redact(msg)}")

    def status(self) -> dict:
        return {
            "name": self.name,
            "state": self.state,
            "mode": self.mode,
            "platforms": self.platforms,
            "restarts": self.restarts,
            "last_exit": self.last_exit,
            "pid": self._proc.pid if self._proc and self._proc.poll() is None else None,
        }

    def logs(self) -> list[str]:
        return list(self._logs)


def plan_runners(cfg: dict, source: str = LOCAL_SOURCE, role: str = "vps") -> dict[str, dict]:
    """
    Translate a desired config into the set of runners we should have.

    Returns { key: {"cmd", "platforms", "mode"} }. Keys are stable so apply() can
    diff against currently-running processes:
      passthrough:<platform>   one HEVC copy per passthrough/ertmp output (hub)
      source_forward           push the tenant HEVC to the GPU bridge (hub)
      deliver:<orientation>    tee the GPU's H.264 return to its platforms (hub)
      gpu:transcode            the GPU backend's single decode -> N-encode runner

    `source` is the loopback URL each runner reads (per-tenant on a multi-tenant VPS
    hub; defaults to the module-global LOCAL_SOURCE). `role`:
      'vps' (default) — card-less trusted hub (no NVENC): passthrough + ertmp directly,
                        plus source_forward + deliver once the tenant's GPU backend is up.
      'gpu'           — GPU backend: a single transcode runner driven by gpu-config
                        (`groups` + `return` URLs); one decode -> N encodes -> RTMPS
                        returns to the hub. No passthrough/ertmp here.
    """
    # GPU BACKEND role: a single transcode runner driven by gpu-config (per-orientation
    # `groups` + `return` URLs), NOT the per-platform `outputs` set. One decode → N
    # encodes → N RTMPS returns to the VPS. No passthrough/ertmp/preview here.
    if role == "gpu":
        groups = cfg.get("groups") or []
        returns = cfg.get("return") or {}
        if not groups or not returns:
            return {}
        return {
            "gpu:transcode": {
                "cmd": build_gpu_transcode_cmd(
                    source, groups, returns, cfg.get("crop") or {},
                    int(cfg.get("source_width") or SOURCE_WIDTH),
                    int(cfg.get("source_height") or SOURCE_HEIGHT),
                ),
                "platforms": [],
                "mode": "gpu",
            },
        }

    outputs = [o for o in cfg.get("outputs", []) if o.get("enabled")]

    passthrough = [o for o in outputs if o.get("mode") == "passthrough"]
    ertmp = [o for o in outputs if o.get("mode") == "ertmp"]

    plan: dict[str, dict] = {}

    for o in passthrough:
        plan[f"passthrough:{o['name']}"] = {
            "cmd": build_passthrough_cmd(o, source),
            "platforms": [o["name"]],
            "mode": "passthrough",
        }

    for o in ertmp:
        plan[f"passthrough:{o['name']}"] = {
            "cmd": build_ertmp_cmd(o, source),
            "platforms": [o["name"]],
            "mode": "ertmp",
        }

    # VPS transcode bridge: when this tenant has a GPU backend (cfg.bridge present, set
    # by main_vps from hub-config), forward the source HEVC to the GPU's listener and
    # fan its H.264 return out to the transcode platforms. The bridge only appears in
    # hub-config once the gpu node is 'ready'; until then the transcode silently doesn't
    # deliver and passthrough/ertmp keep serving (the "degrade, never direct-to-GPU" rule).
    if role == "vps":
        bridge = cfg.get("bridge")
        sf = bridge.get("source_forward") if bridge else None
        if bridge and sf:
            plan["source_forward"] = {
                "cmd": build_source_forward_cmd(source, sf),
                "platforms": [],
                "mode": "source_forward",
            }
            for ro in bridge.get("return_outputs", []):
                orient = ro.get("orientation", "landscape")
                targets = ro.get("targets", [])
                frm = ro.get("from", "")
                if targets and frm:
                    plan[f"deliver:{orient}"] = {
                        "cmd": build_deliver_cmd(f"rtmp://127.0.0.1:1935/{frm}", targets),
                        "platforms": [t.get("name") for t in targets],
                        "mode": f"deliver:{orient}",
                    }

    return plan


class Supervisor:
    """Owns all OutputRunners and applies config changes."""

    def __init__(self, source: str = LOCAL_SOURCE, role: str = "vps"):
        # Per-instance loopback source + role. On a multi-tenant VPS hub each tenant
        # gets its own Supervisor(source=<its read URL>, role='vps'); the GPU backend
        # uses Supervisor(source=<bridge listener>, role='gpu').
        self.source = source
        self.role = role
        self.runners: dict[str, OutputRunner] = {}
        self.lock = threading.Lock()
        # Grace-period stop: a brief OBS disconnect shouldn't tear everything
        # down. schedule_stop() defers stop_all(); a start cancels it.
        self.grace_seconds = float(os.environ.get("RELAY_STOP_GRACE", "20"))
        self._stop_timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()

    # ---- grace-period stop ----------------------------------------------
    def schedule_stop(self) -> None:
        """Stop after grace_seconds unless a start arrives first."""
        with self._timer_lock:
            if self._stop_timer is not None:
                self._stop_timer.cancel()
            if self.grace_seconds <= 0:
                self.stop_all()
                return
            self._stop_timer = threading.Timer(self.grace_seconds, self._grace_fire)
            self._stop_timer.daemon = True
            self._stop_timer.start()

    def _grace_fire(self) -> None:
        with self._timer_lock:
            self._stop_timer = None
        self.stop_all()

    def cancel_pending_stop(self) -> bool:
        """Cancel a scheduled stop (called when OBS reconnects). True if one was pending."""
        with self._timer_lock:
            if self._stop_timer is not None:
                self._stop_timer.cancel()
                self._stop_timer = None
                return True
        return False

    def stop_pending(self) -> bool:
        with self._timer_lock:
            return self._stop_timer is not None

    def apply(self, cfg: dict) -> None:
        """Reconcile running processes with the desired (grouped) config."""
        with self.lock:
            _register_secrets(cfg, self.source)
            desired = plan_runners(cfg, self.source, self.role)

            # stop & remove runners no longer wanted
            for key in list(self.runners):
                if key not in desired:
                    self.runners.pop(key).stop()

            for key, spec in desired.items():
                runner = self.runners.get(key)
                if runner is None or runner.cmd != spec["cmd"]:
                    # new group, or its command (platforms/bitrate/crop) changed -> rebuild
                    if runner is not None:
                        runner.stop()
                    runner = OutputRunner(
                        key, spec["cmd"], spec["platforms"], spec["mode"]
                    )
                    self.runners[key] = runner
                runner.start()

    def stop_all(self) -> None:
        with self.lock:
            for runner in self.runners.values():
                runner.stop()
        with _ertmp_cache_lock:
            _ertmp_session_cache.clear()

    def restart_all(self, cfg: dict) -> None:
        self.stop_all()
        time.sleep(1)
        self.apply(cfg)

    def status(self) -> list[dict]:
        with self.lock:
            return [r.status() for r in self.runners.values()]

    def logs(self, name: str) -> list[str]:
        with self.lock:
            r = self.runners.get(name)
            return r.logs() if r else []


# Convenience for ad-hoc CLI use: `python supervisor.py` runs from config.json.
if __name__ == "__main__":
    sup = Supervisor()
    cfg = load_config()
    sup.apply(cfg)
    print("Relay started. Ctrl-C to stop.")
    try:
        while True:
            time.sleep(2)
            for s in sup.status():
                print(s)
    except KeyboardInterrupt:
        sup.stop_all()
        print("\nstopped")

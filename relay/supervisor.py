"""
supervisor.py — builds and manages FFmpeg processes for streaming fan-out.

Architecture (grouped transcode + tee fan-out):
  Pulls the live HEVC feed from the local MediaMTX SRT loopback and runs at most
  three kinds of process:

    1. Landscape group : 1 NVDEC decode -> 1 NVENC H.264 encode -> tee fan-out to
                         every enabled landscape platform (Twitch/Kick/…).
    2. Portrait group  : 1 NVDEC decode -> crop (user zoom/position) -> scale 9:16
                         -> 1 NVENC H.264 encode -> tee fan-out to every enabled
                         portrait platform (TikTok / YouTube vertical / FB Reels).
    3. Passthrough     : per-output HEVC copy -> HLS (YouTube landscape only).

  This replaces the old "one full transcode per platform" model. Instead of N
  decodes + N encodes, we do at most 2 decodes + 2 encodes regardless of how many
  platforms share each orientation — the encode happens once and the FFmpeg `tee`
  muxer copies the finished bitstream to each destination (`onfail=ignore` so one
  platform dropping never disturbs the others).

Each group runs in its own thread, captures FFmpeg stderr into a ring buffer, and
auto-restarts with exponential backoff while it is supposed to be running.
"""

from __future__ import annotations

import collections
import json
import os
import subprocess
import threading
import time
import urllib.parse

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

LOG_LINES = 250
RESTART_MIN = 2.0      # seconds
RESTART_MAX = 30.0     # seconds

# ---- secret redaction ----------------------------------------------------
# Stream keys end up embedded in the FFmpeg command (rtmp://host/app/<KEY>) and
# in FFmpeg's own "Output #0 ... to '<url>'" banner. Both flow into the in-memory
# log ring buffer, which the debug panel can surface — so a key must never be
# written there verbatim. We keep a live set of the actual key strings (refreshed
# on every apply) and literal-replace them in every log line. Literal replacement
# is exact: no regex guesswork, no over-redaction of harmless path segments.
_SECRETS: set[str] = set()


def _register_secrets(cfg: dict) -> None:
    """Collect every stream key from the live config so _redact can scrub them."""
    # The per-pod ingest key appears in the SRT loopback source URL on the cmd.
    ingest = os.environ.get("SLIMCAST_INGEST_KEY", "").strip()
    if len(ingest) >= 4:
        _SECRETS.add(ingest)
    for o in cfg.get("outputs", []):
        key = (o.get("key") or "").strip()
        if len(key) >= 4:
            _SECRETS.add(key)
        # YouTube HLS passthrough carries the key as the cid= query param.
        url = o.get("url") or ""
        if "cid=" in url:
            cid = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("cid", [""])[0]
            if len(cid) >= 4:
                _SECRETS.add(cid)


def _redact(msg: str) -> str:
    for s in _SECRETS:
        msg = msg.replace(s, "***")
    return msg


def _input_args(source: str) -> list[str]:
    """Per-protocol input flags."""
    if source.startswith("rtsp"):
        return ["-rtsp_transport", "tcp"]
    if source.startswith("srt"):
        return ["-fflags", "+genpts"]
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


PLATFORM_MAX_BITRATE: dict[str, int] = {
    "twitch": 8000,
    "kick": 8000,
    "youtube": 9000,
    "tiktok": 4500,
}

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


def portrait_crop_rect(crop: dict | None) -> tuple[int, int, int, int]:
    """
    Translate the user's framing controls into an FFmpeg crop rectangle.

    User-facing controls (stored per account on slimcast.com):
      zoom  >= 1.0  : 1.0 uses the full source height; higher zooms in (tighter).
      pos_x 0..1    : horizontal position of the crop window (0 left, .5 center, 1 right).
      pos_y 0..1    : vertical position of the crop window (0 top, .5 center, 1 bottom).

    Returns (w, h, x, y) for FFmpeg `crop=w:h:x:y`, clamped to the source frame and
    snapped to even pixels. The window is always 9:16 so it scales cleanly to 1080×1920.
    """
    crop = crop or {}
    zoom = max(1.0, float(crop.get("zoom", 1.0)))
    pos_x = min(1.0, max(0.0, float(crop.get("pos_x", 0.5))))
    pos_y = min(1.0, max(0.0, float(crop.get("pos_y", 0.5))))

    # Tallest possible 9:16 window at this zoom, bounded by source height.
    ch = SOURCE_HEIGHT / zoom
    cw = ch * PORTRAIT_WIDTH / PORTRAIT_HEIGHT  # ch * 9/16

    # If the window is wider than the source, clamp width and re-derive height.
    if cw > SOURCE_WIDTH:
        cw = SOURCE_WIDTH
        ch = cw * PORTRAIT_HEIGHT / PORTRAIT_WIDTH  # cw * 16/9

    cw, ch = _even(cw), _even(ch)
    cx = _even((SOURCE_WIDTH - cw) * pos_x)
    cy = _even((SOURCE_HEIGHT - ch) * pos_y)
    return cw, ch, cx, cy


def _encode_flags(bv: int, fps: int) -> list[str]:
    """Shared NVENC H.264 quality ladder + AAC audio. Do not degrade these."""
    bufsize = bv * 2  # 2x bitrate: headroom for complexity/explosion spikes
    gop = fps * 2     # 2-second keyframe interval
    return [
        "-c:v", "h264_nvenc",
        # p6 (not p7): near-identical quality at 8 Mbps but ~1.5-2x the encode
        # throughput, so the two NVENC engines have headroom for both the
        # landscape and portrait encodes (and multi-user packing later).
        "-preset", "p6", "-tune", "hq", "-multipass", "fullres",
        "-rc", "cbr", "-b:v", f"{bv}k", "-maxrate", f"{bv}k", "-bufsize", f"{bufsize}k",
        "-profile:v", "high", "-g", str(gop),
        "-bf", "3", "-b_ref_mode", "middle", "-rc-lookahead", "32",
        "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "6",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    ]


def _tee_targets(outputs: list[dict]) -> str:
    """Build the FFmpeg `tee` output string. onfail=ignore keeps the shared
    encode alive when a single platform's ingest drops or rejects the stream."""
    parts = []
    for o in outputs:
        url = _full_rtmp_url(o)
        parts.append(f"[f=flv:onfail=ignore]{url}")
    return "|".join(parts)


def _group_bitrate(outputs: list[dict]) -> int:
    """A tee group shares one encode, so the bitrate is the smallest platform cap
    in the group (the largest the weakest platform will accept)."""
    vals = []
    for o in outputs:
        cap = PLATFORM_MAX_BITRATE.get(o.get("name", ""), 8000)
        vals.append(min(int(o.get("bitrate_kbps", cap)), cap))
    return min(vals) if vals else 6000


def _group_fps(outputs: list[dict]) -> int:
    return min((int(o.get("fps", 60)) for o in outputs), default=60)


def build_passthrough_cmd(out: dict, source: str = LOCAL_SOURCE) -> list[str]:
    """HEVC copy -> HLS PUT to YouTube's HLS ingest URL (no re-encode).

    YouTube ingests HEVC only over HLS (its RTMP endpoint is H.264-only), and it
    requires fragmented-MP4 (CMAF) segments for HEVC — MPEG-TS is H.264-only here.
    `-c copy` passes the source HEVC video + AAC audio straight through untouched,
    so YouTube gets full source quality with zero GPU encode cost.
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
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "delete_segments+omit_endlist+independent_segments",
        out["url"],
    ]


def build_group_cmd(
    outputs: list[dict],
    orientation: str,
    crop: dict | None = None,
    source: str = LOCAL_SOURCE,
) -> list[str]:
    """
    One decode -> one NVENC H.264 encode -> tee fan-out to every output in the group.

    Landscape: stays entirely on the GPU (NVDEC -> NVENC), no filter.
    Portrait : NVDEC -> hwdownload -> crop (user framing) -> scale 1080×1920 -> NVENC.
               Crop/scale runs on the CPU (scale_cuda can't crop+pad); it's a single
               low-cost pass and the portrait group is the lower-bitrate one.
    """
    bv = _group_bitrate(outputs)
    fps = _group_fps(outputs)

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
        *_input_args(source),
        "-i", source,
    ]

    cmd += ["-map", "0:v", "-map", "0:a"]

    if orientation == "portrait":
        cw, ch, cx, cy = portrait_crop_rect(crop)
        vf = (
            f"hwdownload,format=nv12,"
            f"crop={cw}:{ch}:{cx}:{cy},"
            f"scale={PORTRAIT_WIDTH}:{PORTRAIT_HEIGHT}"
        )
        cmd += ["-vf", vf]

    cmd += _encode_flags(bv, fps)
    cmd += ["-f", "tee", _tee_targets(outputs)]
    return cmd


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
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._logs: collections.deque[str] = collections.deque(maxlen=LOG_LINES)
        self.state = "stopped"   # stopped | running | restarting | error
        self.restarts = 0
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
        p = self._proc
        if p and p.poll() is None:
            try:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
            except Exception:
                pass

    # ---- run loop --------------------------------------------------------
    def _run_loop(self) -> None:
        backoff = RESTART_MIN
        while not self._stop.is_set():
            self._log(f"$ {' '.join(self.cmd)}")
            try:
                self._proc = subprocess.Popen(
                    self.cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
            except FileNotFoundError:
                self.state = "error"
                self._log("ERROR: ffmpeg not found on PATH")
                return

            self.state = "running"
            started = time.time()
            assert self._proc.stderr is not None
            for line in self._proc.stderr:
                self._log(line.rstrip())

            self.last_exit = self._proc.wait()
            ran_for = time.time() - started

            if self._stop.is_set():
                self.state = "stopped"
                self._log("stopped")
                return

            # crashed/disconnected -> back off and retry
            self.state = "restarting"
            self.restarts += 1
            # reset backoff if the process was healthy for a while
            backoff = RESTART_MIN if ran_for > 60 else min(backoff * 2, RESTART_MAX)
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


def plan_runners(cfg: dict) -> dict[str, dict]:
    """
    Translate a desired config into the set of runners we should have.

    Returns { key: {"cmd", "platforms", "mode"} }. Keys are stable so apply() can
    diff against currently-running processes:
      passthrough:<platform>   one HEVC copy per passthrough output
      group:landscape          shared landscape H.264 encode + tee
      group:portrait           shared portrait (cropped) H.264 encode + tee
    """
    outputs = [o for o in cfg.get("outputs", []) if o.get("enabled")]
    crop = cfg.get("crop") or {}

    passthrough = [o for o in outputs if o.get("mode") == "passthrough"]
    transcode = [o for o in outputs if o.get("mode") != "passthrough"]
    landscape = [o for o in transcode if o.get("orientation", "landscape") != "portrait"]
    portrait = [o for o in transcode if o.get("orientation") == "portrait"]

    plan: dict[str, dict] = {}

    for o in passthrough:
        plan[f"passthrough:{o['name']}"] = {
            "cmd": build_passthrough_cmd(o),
            "platforms": [o["name"]],
            "mode": "passthrough",
        }

    if landscape:
        plan["group:landscape"] = {
            "cmd": build_group_cmd(landscape, "landscape", crop),
            "platforms": [o["name"] for o in landscape],
            "mode": "landscape",
        }

    if portrait:
        plan["group:portrait"] = {
            "cmd": build_group_cmd(portrait, "portrait", crop),
            "platforms": [o["name"] for o in portrait],
            "mode": "portrait",
        }

    return plan


class Supervisor:
    """Owns all OutputRunners and applies config changes."""

    def __init__(self):
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
            _register_secrets(cfg)
            desired = plan_runners(cfg)

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


# ── Active-supervisor singleton ───────────────────────────────────────────────
# agent.py calls set_active() after creating its Supervisor so that app.py
# (running in the same process via an in-process uvicorn thread) can call
# get_active() and serve the *live* pipeline's logs and status — not a
# separate, empty Supervisor instance (the old dual-supervisor gap).
_active: "Supervisor | None" = None


def set_active(s: "Supervisor") -> None:
    global _active
    _active = s


def get_active() -> "Supervisor | None":
    return _active


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

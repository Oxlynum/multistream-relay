"""
supervisor.py — builds and manages one FFmpeg process per streaming destination.

Pulls the live HEVC feed from the local MediaMTX ingest (loopback RTSP) and:
  - YouTube  : copies the HEVC bitstream into HLS (no re-encode)
  - Twitch   : transcodes to H.264 via NVENC -> RTMP
  - Kick     : transcodes to H.264 via NVENC -> RTMP(S)

Each output runs in its own thread, captures FFmpeg stderr into a ring buffer,
and auto-restarts with exponential backoff while it is supposed to be running.
"""

from __future__ import annotations

import collections
import json
import os
import signal
import subprocess
import threading
import time

CONFIG_PATH = os.environ.get("RELAY_CONFIG", "config.json")
# Loopback feed republished by MediaMTX. We pull over SRT (MPEG-TS), NOT RTSP:
# MediaMTX's RTP/HEVC packetization mangles Apple VideoToolbox's temporal-layered
# HEVC ("Illegal temporal ID in RTP/HEVC packet" -> dropped frames -> artifacts).
# SRT carries the HEVC in MPEG-TS cleanly. Loopback SRT is lossless + low latency.
LOCAL_SOURCE = os.environ.get(
    "RELAY_SOURCE", "srt://127.0.0.1:8890?streamid=read:live"
)


def _input_args(source: str) -> list[str]:
    """Per-protocol input flags."""
    if source.startswith("rtsp"):
        return ["-rtsp_transport", "tcp"]
    if source.startswith("srt"):
        # tolerate brief loopback hiccups without exiting
        return ["-fflags", "+genpts"]
    return []
LOG_LINES = 250
RESTART_MIN = 2.0      # seconds
RESTART_MAX = 30.0     # seconds


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
    "facebook": 4000,
}

# Source resolution (must match OBS output — used for pillarbox pad calculation).
SOURCE_WIDTH = int(os.environ.get("SOURCE_WIDTH", "1920"))
SOURCE_HEIGHT = int(os.environ.get("SOURCE_HEIGHT", "1080"))


def build_cmd(out: dict, source: str = LOCAL_SOURCE) -> list[str]:
    """Return an FFmpeg argv list for a single output definition."""
    mode = out.get("mode", "transcode")

    if mode == "passthrough":
        # HEVC copy -> HLS TS segments, PUT to YouTube's HLS ingest URL.
        return [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            *_input_args(source),
            "-i", source,
            "-c", "copy",
            "-f", "hls",
            "-method", "PUT",
            "-hls_time", "2",
            "-hls_list_size", "5",
            "-hls_segment_type", "mpegts",
            "-hls_flags", "delete_segments+omit_endlist+independent_segments",
            out["url"],
        ]

    # transcode mode: NVDEC decode -> H.264 NVENC -> RTMP(S)
    platform = out.get("name", "")
    max_bv = PLATFORM_MAX_BITRATE.get(platform, 8000)
    bv = min(int(out.get("bitrate_kbps", max_bv)), max_bv)
    fps = int(out.get("fps", 60))
    gop = str(fps * 2)  # 2-second keyframe interval
    orientation = out.get("orientation", "landscape")
    portrait = orientation == "portrait"

    if portrait:
        # Portrait output (TikTok 9:16): CPU-side pillarbox.
        # Landscape source → scale down preserving aspect → pad to 1080×1920.
        # Using CPU (scale + pad) because scale_cuda does not support pad.
        # Acceptable: portrait outputs are lower bitrate (≤4500 kbps).
        out_w, out_h = 1080, 1920
        vf = (
            f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            *_input_args(source),
            "-i", source,
            "-vf", vf,
        ]
    else:
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
            *_input_args(source),
            "-i", source,
        ]
        width = out.get("width")
        height = out.get("height")
        if width and height:
            # GPU-side rescale; only added when the output differs from source.
            cmd += ["-vf", f"scale_cuda={int(width)}:{int(height)}"]

    bufsize = str(bv * 2)  # 2x bitrate: headroom for explosion/complexity spikes
    cmd += [
        "-c:v", "h264_nvenc",
        "-preset", "p7", "-tune", "hq", "-multipass", "fullres",
        "-rc", "cbr", "-b:v", f"{bv}k", "-maxrate", f"{bv}k", "-bufsize", f"{bufsize}k",
        "-profile:v", "high", "-g", gop,
        "-bf", "3", "-b_ref_mode", "middle", "-rc-lookahead", "32",
        "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "6",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-f", "flv", _full_rtmp_url(out),
    ]
    return cmd


class OutputRunner:
    """Supervises a single FFmpeg process for one destination."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.name = cfg["name"]
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
            cmd = build_cmd(self.cfg)
            self._log(f"$ {' '.join(cmd)}")
            try:
                self._proc = subprocess.Popen(
                    cmd,
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
        self._logs.append(f"{time.strftime('%H:%M:%S')} {msg}")

    def status(self) -> dict:
        return {
            "name": self.name,
            "state": self.state,
            "enabled": bool(self.cfg.get("enabled")),
            "mode": self.cfg.get("mode", "transcode"),
            "restarts": self.restarts,
            "last_exit": self.last_exit,
            "pid": self._proc.pid if self._proc and self._proc.poll() is None else None,
        }

    def logs(self) -> list[str]:
        return list(self._logs)


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
        """Reconcile running processes with the desired config."""
        with self.lock:
            desired = {o["name"]: o for o in cfg.get("outputs", [])}

            # stop & remove runners no longer present
            for name in list(self.runners):
                if name not in desired:
                    self.runners.pop(name).stop()

            for name, out in desired.items():
                runner = self.runners.get(name)
                if runner is None:
                    runner = OutputRunner(out)
                    self.runners[name] = runner
                else:
                    # config changed -> restart with new settings
                    if runner.cfg != out:
                        runner.stop()
                        runner = OutputRunner(out)
                        self.runners[name] = runner

                if out.get("enabled"):
                    runner.start()
                else:
                    runner.stop()

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

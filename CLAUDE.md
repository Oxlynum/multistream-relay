# CLAUDE.md — context for continuing this project

## What it is
Upload one HEVC stream from a Mac mini M4 (Apple VT hardware encoder) to a rented
cloud GPU; the GPU transcodes and fans out to Twitch, Kick, YouTube. Purpose:
let low-upload streamers and multistreamers push good 1080p60 that H.264 couldn't
fit. Long-term goal: a sellable, white-label, **self-hosted** product (the
customer rents their own GPU; you never hold their keys). See docs/PRODUCT_PLAN.md.

## Current status
- Working end-to-end; Twitch confirmed live at 1080p.
- Hardening quality; moving toward a UDP/SRT host near the user (Vultr Atlanta).

## Layout
- `relay/` — the deployable server. All runtime files live here together so the
  scripts' relative paths work. Deploy this folder to the GPU box.
- `docs/ARCHITECTURE.md` — pipeline detail, tuning, caveats.
- `docs/PRODUCT_PLAN.md` — productization, licensing, codec roadmap.

## Architecture (load-bearing decisions — read before changing)
1. **Uplink transport depends on the host.** RunPod = TCP-only → enhanced-RTMP
   HEVC. UDP-capable hosts (Vultr/AWS) → SRT (loss/jitter resilient, the
   production target). MediaMTX accepts both; only `mediamtx.yml` + the OBS URL
   change.
2. **Encoders pull the internal feed over SRT, not RTSP.** RTSP/RTP mangles
   Apple's temporal-layered HEVC ("Illegal temporal ID" → dropped frames →
   artifacts). Internal source = `srt://127.0.0.1:8890?streamid=read:live`. Keep
   8890 internal on RunPod; on a UDP host it can also serve as the SRT *ingest*
   port for OBS.
3. **FFmpeg must match the GPU driver.** The generic BtbN "latest" build needs
   NVIDIA driver 610+ and FAILS on typical cloud GPUs (driver ~550 = NVENC API
   12.2). `setup.sh`/Dockerfile pin **jellyfin-ffmpeg 7.1.4-3**, verified on
   driver 550.x. Don't swap back to a bleeding-edge build.
4. **Use hardware codecs only** (Apple VT, NVDEC, NVENC) — both for quality and
   to keep HEVC patent exposure on the vendors who already licensed it.

## Files
- `supervisor.py` — `build_cmd()` builds per-output FFmpeg argv; `_input_args()`
  picks flags per protocol (srt/rtsp). Supervisor/OutputRunner manage processes
  with auto-restart + a cancellable grace-period stop.
- `app.py` — FastAPI: config CRUD, start/stop/restart (grace flag), status, logs.
  Auth = HTTP Basic OR `?token=` (for the OBS browser dock).
- `static/index.html` — control-panel UI.
- `hook.sh` + `mediamtx.yml` runOnReady/runOnNotReady — OBS-triggered auto
  start/stop with grace.
- `setup.sh` (idempotent installer) + `run.sh` (creds + launch). Re-run both
  after any pod restart (only the deploy folder persists; binaries don't).

## Codec roadmap
- HEVC now. AV1 later: royalty-free, ~30% better, server-side OUTPUT only
  (Apple M4 can't AV1-encode), needs **Ada GPU** (RTX 40 / L4 / L40) — NOT Ampere.

## Good next tasks
- One-click provider template/image (kills manual setup) — highest product value.
- OBS Python script for native start/stop + settings + provider presets.
- Optional pipeline optimization: decode once, share across outputs (saves VRAM
  on small GPUs like the 2 GB A16 slice).
- Optional: pass audio through (`-c:a copy`) to avoid double-encoding.
- Add SRT ingest passphrase when exposing UDP publicly.

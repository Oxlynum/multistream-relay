# relay/ — the SlimCast relay image (hub + GPU)

One Docker image, **two roles**, selected at runtime by `RELAY_ROLE` via `agent.py`:

| Role (`RELAY_ROLE`) | Runs on | What it does |
|---|---|---|
| `vps` → `main_vps` | the trusted **VPS hub** (Hetzner) | MediaMTX SRT ingest (`:8890`), YouTube/eligible-Twitch **passthrough** (no GPU), the mpegts-over-TLS **bridge** to a GPU for transcode streams, and the **tee fan-out** to every platform. Holds the stream keys. |
| `gpu` → `main_gpu` | a rented **cloud GPU** (Vast / RunPod) | Terminates the TLS bridge on `:8899`, **NVDEC HEVC-decode → NVENC H.264-encode** (one shared encode per orientation), and returns the H.264 video to the hub. **Never sees a stream key.** |

The source is **any HEVC-capable hardware encoder** — Apple VideoToolbox on Mac, NVENC / AMF / QSV
on PC. The relay decodes HEVC and doesn't care what produced it. (One nuance: the internal loopback
is **SRT, not RTSP**, because VideoToolbox emits temporal-layered HEVC that RTSP mangles — NVENC/AMF
B-pyramid HEVC hits the same path.)

## You don't deploy this by hand

In production the **broker provisions the relay automatically** — the web app rents the hub and GPU
when a user hits Start Streaming, injects role + config env, and tears them down on stop. There is
**no** manual `setup.sh` / control-panel / RTMP-ingest flow anymore, and no `:8080` debug panel
(removed 2026-06-29 — stderr goes to `docker logs`).

- **CI builds the image** on any `relay/**` push to `main` → `ghcr.io/oxlynum/multistream-relay:latest`
  plus `:<sha>` rollback tags, and auto-pins `SLIMCAST_RELAY_IMAGE` in Vercel to the new SHA. Never
  pin `:latest` in Vercel (GHCR CDN caching serves stale digests) — CI handles the SHA pin.

## Key files

| File | What it is |
|---|---|
| `agent.py` | Entrypoint. Dispatches on `RELAY_ROLE`, self-reports readiness (`POST /api/agent/ready`), polls its role config every ~10s, posts heartbeats. |
| `supervisor.py` | Builds + supervises the per-role ffmpeg commands. GPU: `build_gpu_transcode_cmd()`. Hub: `build_source_forward_cmd()` / `build_deliver_one_cmd()` (STREAM-02 de-tee: one `-c copy` push per transcode platform, not a shared tee) / `build_passthrough_cmd()` / `build_ertmp_cmd()`. **Read the NVENC-flag landmine comments before editing.** |
| `mediamtx.vps.yml` | The hub's MediaMTX: SRT `:8890` (OBS ingest + loopback) + RTMP `:1935` readiness beacon. `runOnReady` → `hook.sh`. |
| `budget.py` | `CostMeter` — live $/hr from `/proc/net/dev`, GPU-bridge cost telemetry. |
| `bpm_inject.py` | BPM SEI injection for Twitch HEVC eRTMP passthrough. |
| `bridge_proxy.py` | Bridge auth gateway (flag-gated behind `SLIMCAST_BRIDGE_AUTH`). |
| `Dockerfile` | `nvidia/cuda:12.4.1-base` + jellyfin-ffmpeg 7.1.4-3 + MediaMTX. `EXPOSE 1935 8888 8899`. ~0.23 GB. |

## Local testing

```bash
cd relay
docker compose up --build      # needs RELAY_PASSWORD env
```

SRT/UDP ports aren't in compose — test real SRT ingest on a provisioned box (see `CLAUDE.md` →
"Diagnosing on a live Vast pod" and the external `srt-live-transmit` recipe).

## Deeper reference

`CLAUDE.md` → "Key files / relay" and "Architecture (load-bearing)" is authoritative for the
ffmpeg command construction, the codec/quality settings, the TLS-bridge cert landmine, and the
role dispatch. This README intentionally stays high-level so the two don't drift.

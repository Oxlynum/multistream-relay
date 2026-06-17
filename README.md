# Transcoder Multistream Project

Upload one efficient **HEVC** stream from a Mac (Apple hardware encoder) to a
rented cloud GPU; the GPU transcodes and fans it out to **Twitch, Kick, and
YouTube** at once. Built for low-upload streamers and multistreamers — HEVC
carries good 1080p60 through a connection that couldn't push H.264.

Status: **working end-to-end** (Twitch confirmed live at 1080p). Currently
hardening quality and moving toward a UDP/SRT host. See the product plan for the
path to a sellable, white-label, self-hosted product.

## Project structure

```
transcoder-multistream-project/
├── README.md            ← you are here
├── CLAUDE.md            ← context for continuing in Claude Code
├── relay/               ← the deployable server (upload THIS to your GPU box)
│   ├── app.py           control-panel API + auth
│   ├── supervisor.py    builds/supervises the per-platform FFmpeg processes
│   ├── static/index.html  the control-panel UI (also runs as an OBS dock)
│   ├── mediamtx.yml     ingest server config (RTMP in, SRT republish)
│   ├── hook.sh          OBS-triggered auto start/stop
│   ├── setup.sh         one-command installer (FFmpeg + MediaMTX + deps)
│   ├── run.sh           one-command launcher (your password/token baked in)
│   ├── start.sh         starts MediaMTX + the control panel
│   ├── config.example.json
│   ├── requirements.txt
│   ├── Dockerfile / docker-compose.yml
│   └── README.md        deploy + OBS setup walkthrough
└── docs/
    ├── ARCHITECTURE.md  how the pipeline works + tuning + caveats
    └── PRODUCT_PLAN.md  productization: model, codecs, licensing, roadmap
```

## Quick start (deploy the relay)

On your GPU box, from inside `relay/`:

```bash
bash setup.sh                 # installs FFmpeg (jellyfin, driver-matched) + MediaMTX
bash run.sh                   # launches everything (edit your password/token in run.sh)
```

Then point OBS at the box and add the control panel as an OBS dock. Full
step-by-step is in `relay/README.md`.

## RunPod vs Vultr (host choice)

The application is **host-agnostic** — the same code runs anywhere. The only
difference is the **uplink transport**:

- **RunPod** is TCP-only (no UDP) → uplink uses **enhanced-RTMP (HEVC over TCP)**.
  Fine for development and for users on strong connections.
- **Vultr / AWS / other UDP-capable hosts** → uplink can use **SRT**, which
  shrugs off latency, jitter, and packet loss. This is the better transport for
  weak/unstable uploads and is the production target.

Switching providers is a config change (open a UDP port, point OBS at `srt://`),
not a rewrite. Develop features on either; validate final quality on a
UDP/SRT host located near you.

## Codec roadmap

- **HEVC** — today, via hardware codecs only (Apple VT encode, NVENC/NVDEC).
- **AV1** — royalty-free, ~30% more efficient, a future server-side output on
  **Ada-class GPUs** (RTX 40-series / L4 / L40). Ampere (A16) is HEVC-only.

See `docs/PRODUCT_PLAN.md` for the full strategy, licensing posture, and roadmap.

# SlimCast — Architecture Overview

> This is a readable map of the current pipeline. **The load-bearing, authoritative reference is
> [`/CLAUDE.md`](../CLAUDE.md)** (§ "Architecture (load-bearing)") — read it before changing
> anything. This file intentionally stays high-level so the two can't drift.
>
> _History: the original design was a direct OBS→GPU "all-in-one" relay on a single rented pod. That
> path was **deleted 2026-06-29** in favor of the VPS-hub topology below. The pre-2026-06-29
> blueprint lives in [`archive/`](archive/)._

## The shape

One efficient HEVC upload from OBS becomes many platform streams — and the heavy fan-out leaves a
datacenter, not the streamer's uplink.

```
  OBS (Mac or PC)                 Trusted VPS hub (Hetzner)            Cloud GPU (Vast / RunPod)
  any HEVC encoder     HEVC/SRT   ┌────────────────────────────┐  TLS  ┌────────────────────────┐
  ────────────────────────────►   │ MediaMTX SRT ingest :8890  │ :8899 │ NVDEC HEVC-decode       │
  Apple VT / NVENC /              │ passthrough (no GPU):      │◄─────►│ NVENC  H.264-encode     │
  AMF / QSV                       │  • YouTube  HEVC→HLS       │bridge │ (one shared encode      │
                                  │  • Twitch   HEVC eRTMP*    │       │  per orientation)       │
                                  │ transcode → TLS bridge ───►│       │ returns H.264 to hub    │
                                  │ per-platform delivery      │       └────────────────────────┘
                                  └─────────────┬──────────────┘
                                                ▼
                                Twitch · Kick · YouTube · TikTok
```

\* Twitch HEVC eRTMP passthrough is used only for accounts Twitch authorizes for it; everyone else
falls through to the H.264 transcode group.

## Source: any HEVC hardware encoder, Mac or PC

OBS → hub ingest is **HEVC over SRT** — a bitstream transport. The hub and GPU decode HEVC and do
**not** care what produced it, so the source can be **Apple VideoToolbox** (macOS) or **NVENC /
AMF / QSV** (Windows). The only Apple-specific nuance is a technical one: VideoToolbox emits
*temporal-layered* HEVC, which is why the internal loopback uses **SRT, not RTSP** (RTSP mangles
temporal layers). NVENC/AMF/QSV HEVC with a B-pyramid hits the same path.

## Load-bearing invariants (summary — full detail in `CLAUDE.md`)

1. **One way to reach a GPU.** OBS → SRT → **trusted VPS hub** → mpegts-over-TLS bridge (`:8899`) →
   GPU → H.264 back to the hub → hub pushes to platforms. OBS never publishes to a GPU.
2. **Stream keys never reach a rented GPU.** The hub holds keys and does all platform delivery; the
   GPU only transcodes and returns video.
3. **Internal loopback is SRT, not RTSP** (temporal-layered HEVC — see above).
4. **Hardware codecs only.** NVDEC decode + NVENC H.264 encode on the GPU; CPU only for the portrait
   crop/scale. YouTube landscape is `-c copy` HEVC passthrough (no re-encode).
5. **Passthrough runs GPU-free on the hub.** A GPU is rented only when an H.264 platform (Kick,
   TikTok, non-eligible Twitch) needs a transcode.
6. **Broker picks the GPU, never a human.** Ranked by NVENC-driver preference → proximity **to the
   hub** (the VPS↔GPU bridge leg dominates latency) → price, under a hard $/hr ceiling. Providers
   (Vast, RunPod, more later) are interchangeable behind one TCP bridge protocol.
7. **No idle billing.** A universal renew-deadline **lease** (heartbeat-driven) plus a daily reaper
   tears down hubs and GPUs when a stream ends or a box goes dark.
8. **Vercel stores config; the box executes it.** Stream keys live encrypted in Supabase; the relay
   polls its role config and posts heartbeats. Keys are AES-256-GCM at rest and decrypted only to
   the trusted hub.

## Components

- **`web/`** — Next.js 16 on Vercel: auth, dashboard, billing (Supabase + Stripe), the hub/GPU
  broker, and the OBS-dock API. See `CLAUDE.md` → "Key files / web".
- **`relay/`** — one Docker image, two roles (`agent.py` dispatches on `RELAY_ROLE`): the **hub**
  (`main_vps`, MediaMTX + passthrough + per-platform delivery) and the **GPU backend** (`main_gpu`, the TLS
  bridge + NVDEC/NVENC transcode). Built by CI to GHCR.
- **`slimcast-obs/`** — the C++ OBS plugin/dock that drives the whole lifecycle. Encoder-agnostic
  detection (Apple VT / NVENC / QSV / AMF). Windows build status: [`macvpc.md`](macvpc.md).

## Encoder tuning (the "crisp in fast motion" part)

The GPU's shared H.264 encode is tuned for high-motion quality — `p7 / tune hq / fullres`, CBR with
2× bufsize, `bf=2 b_ref_mode=middle`, `rc-lookahead=32`, spatial+temporal AQ (`aq-strength=8`), a
2s GOP aligned to HLS segments, and `forced-idr=1`. These are load-bearing quality settings — see
`CLAUDE.md` → `supervisor.py` notes (and its NVENC-flag landmines) before touching them.

## Roadmap & test runbooks

**Active plans** (`plans/`): `enterprise-audit.md` (hardening roadmap) · `dualstream.md` (vertical 9:16).
**Reference:** `PRODUCT_PLAN.md` (business/licensing) · `production-checklist.md` (pre-launch cutover) ·
`macvpc.md` (Windows enablement).
**History** (`archive/`): `gputest.md` (GPU transcode-bridge — Phase 2 passed) · `hevcpasstest.md`
(hub passthrough — proven live) · `srt-rtmp-split-plan.md` (superseded by the shipped hub bridge).

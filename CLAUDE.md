# CLAUDE.md — context for continuing this project

## What it is
**SlimCast** — a consumer multistreaming SaaS. User pushes one HEVC stream from
OBS on a Mac mini M4 (Apple VT hardware encoder) to a RunPod cloud GPU; the GPU
transcodes to H.264 and fans out simultaneously to Twitch, Kick, YouTube, TikTok,
and Facebook. Purpose: let low-upload streamers push 1080p60 to multiple platforms
without touching a terminal, config file, or RTMP URL. Everything is controlled
from the SlimCast web app (slimcast.com) and a native OBS plugin.

**Business model:** pure pay-per-use streaming credits. $2/hr, billed in seconds.
No subscription. 2 free hours on signup.

## Current status
- Pipeline confirmed working end-to-end (Twitch at 1080p60).
- Provider: **RunPod** (pay-per-use, Ada NVENC, ~$0.20/hr, ~45s cold start).
- Web app (Next.js) in `web/` — Supabase + Stripe wired, deploys to Vercel.
- OBS plugin in `obs-relay-control/` — complete v1.0.0 C++ plugin with .pkg/.exe
  installer and CI/CD. Needs to be updated for the new Vercel-agent architecture.
- **Active build sprint:** productizing into a fully self-serve SaaS.
  See the plan at `/Users/danielaltom/.claude/plans/alright-lets-plan-this-eventual-clover.md`

## Layout
- `relay/` — GPU server. supervisor.py + app.py + mediamtx + hook.sh.
  agent.py (to be built) replaces setup.sh/run.sh for Docker auto-boot.
- `web/` — Next.js app: auth, dashboard, platform config, credit billing, OBS dock.
  Stack: Next.js + Supabase + Stripe. Deploys to Vercel.
- `obs-relay-control/` — C++ OBS plugin (v1.0.0 complete). Manages relay from OBS.
- `docs/` — architecture notes and product plan (may be stale vs plan file above).

## Target user flow (the north star — nothing should require a terminal)
1. Sign up → onboarding wizard auto-starts
2. Paste stream keys for desired platforms (Twitch/Kick/YouTube/TikTok/Facebook)
3. Download OBS plugin (.pkg Mac / .exe Windows) → double-click to install
4. "Launch GPU" in wizard → ~45s → GPU online
5. Open OBS → SlimCast panel present → enter SlimCast API key once → done
6. **Every stream:** click Start Streaming in OBS → all platforms go live automatically
7. **Low credits:** OBS plugin warns at 30 min left → hard stop at zero

Technical terms (RTMP, GPU, stream key) are fine as labels in the UI.
They just aren't the brand. The brand is "stream everywhere, no setup."

## Architecture (load-bearing — read before changing)
1. **OBS → GPU transport: enhanced-RTMP HEVC over TCP** (RunPod is TCP-only).
   If/when migrating to a UDP-capable host (Vultr/AWS), switch OBS + mediamtx.yml
   to SRT. MediaMTX accepts both; only the ingest URL and mediamtx.yml change.

2. **Internal loopback: SRT, NOT RTSP.** MediaMTX re-publishes the ingest feed
   internally. FFmpeg encoders pull from `srt://127.0.0.1:8890?streamid=read:live`.
   RTSP/RTP mangles Apple's temporal-layered HEVC → "Illegal temporal ID" →
   dropped frames → artifacts. Keep this SRT loopback. Do not switch to RTSP.

3. **FFmpeg pinned to jellyfin-ffmpeg 7.1.4-3.** Generic BtbN "latest" needs
   NVIDIA driver 610+. RunPod typically runs driver 550.x (NVENC API 12.2).
   This version is verified. Do not swap for a bleeding-edge build.

4. **Hardware codecs only.** NVDEC decode + NVENC H.264 encode. No software
   encode paths. CPU is used only for the TikTok portrait pillarbox filter
   (scale+pad) which is low-bitrate and acceptable.

5. **Vercel stores config, GPU executes it.** Platform RTMP keys live in Supabase,
   never in the Docker image. The GPU agent polls Vercel every 10s for config
   and streams it into supervisor.apply(). One SLIMCAST_API_KEY env var on the pod
   is the only credential it needs.

6. **OBS plugin talks to Vercel, not the GPU.** Plugin authenticates with user's
   API key against slimcast.com/api/agent/*. GPU IP never touches the plugin.

## Key files
### relay/
- `supervisor.py` — build_cmd() per output, OutputRunner (auto-restart + backoff),
  Supervisor (apply/stop_all/grace-period). Quality flags: p7/hq/fullres, CBR,
  2x bufsize, bf=3, rc-lookahead=32, spatial/temporal-aq. Do not degrade these.
- `app.py` — FastAPI control plane (kept for debug; agent wraps it).
- `mediamtx.yml` — RTMP :1935 ingest + SRT :8890 loopback; runOnReady → hook.sh.
- `hook.sh` — triggers supervisor start/stop-with-grace when OBS connects/drops.
- `agent.py` (TO BUILD) — on-boot Docker entrypoint: pairs with Vercel, starts
  MediaMTX + uvicorn, polls config, posts heartbeats, executes control commands.
- `Dockerfile` — nvidia/cuda:12.4.1-runtime-ubuntu22.04, jellyfin-ffmpeg 7.1.4-3,
  MediaMTX v1.9.3. CMD will change from ./start.sh to python3 agent.py.

### web/
- `lib/supabase.ts` — browser + server Supabase clients.
- `lib/stripe.ts` — Stripe client. Price IDs need updating to credit pack prices.
- `lib/runpod.ts` (TO BUILD) — RunPod REST API wrapper (createPod/stopPod/etc.).
- `app/api/agent/*` (TO BUILD) — pair, config, status, control endpoints.
- `app/api/gpu/*` (TO BUILD) — provision, stop, destroy.
- `app/api/platforms/` (TO BUILD) — save/remove platform stream keys.
- `app/api/credits/*` (TO BUILD) — checkout, balance, deduct.
- `app/dashboard/` (TO BUILD) — main hub: GPU card, stream status, credit balance.
- `app/dashboard/platforms/` (TO BUILD) — paste stream keys per platform.
- `app/dashboard/settings/` (TO BUILD) — bitrate/fps/orientation per platform.
- `app/dashboard/credits/` (TO BUILD) — buy credit packs, achievements, history.
- `app/onboarding/` (TO BUILD) — 4-step wizard for new users.
- `app/obs-dock/` (TO BUILD) — compact dark panel loaded inside OBS.
- `middleware.ts` (TO BUILD) — protect /dashboard/* routes.

### obs-relay-control/
- Complete v1.0.0 C++ plugin. Has 3 tabs, CI/CD, .pkg/.exe installer.
- Needs: API key input replacing server IP; relay-api pointing to slimcast.com;
  cloud-provider.cpp removed; TikTok/Facebook platforms added; credit balance display.

## Platforms supported
| Platform | Protocol | Max kbps | Orientation |
|---|---|---|---|
| Twitch | RTMP | 8000 | Landscape |
| Kick | RTMPS | 8000 | Landscape |
| YouTube | HLS passthrough | — | Landscape |
| TikTok | RTMP | 4500 | Portrait (pillarbox) |
| Facebook | RTMPS | 4000 | Landscape |

## Supabase schema (new migration: 20260617000001_agent_schema.sql)
New tables: agent_api_keys, platform_connections, gpu_instances,
stream_sessions, achievements.
New column on profiles: streaming_credits_seconds (integer, default 7200 = 2hr trial).

## Codec roadmap
- HEVC ingest now. AV1 output later (needs Ada GPU — RTX 40/L4/L40, NOT Ampere).
- Audio: currently re-encoded AAC 160k. Future: -c:a copy passthrough.

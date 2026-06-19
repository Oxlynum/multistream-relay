# CLAUDE.md — context for continuing this project

## What it is
**SlimCast** — a consumer multistreaming SaaS. User pushes one HEVC stream from
OBS on a Mac mini M4 (Apple VT hardware encoder) to a cloud GPU; the GPU transcodes
once per orientation and fans each encode out to every platform in that group —
Twitch, Kick, YouTube, TikTok. Purpose: let low-upload streamers push 1080p60 to
multiple platforms without touching a terminal, config file, or RTMP URL.
Everything is controlled from the SlimCast web app (slimcast.com) and a native OBS
plugin.

**Business model:** pure pay-per-use streaming credits. Base $2/hr (1 token),
billed in seconds; +0.2 token/hr per extra transcoded platform. No subscription.
2 free hours on signup.

## Current status
- Pipeline confirmed working end-to-end (Twitch at 1080p60).
- Provider: **RunPod** L4 (community cloud, ~$0.39/hr, ~45s cold start). Selected
  automatically by the availability broker (see Architecture #7) — never picked by
  hand. Hard $1/hr price ceiling.
- Web app (Next.js) in `web/` — Supabase + Stripe wired, deploys to Vercel.
- OBS plugin in `slimcast-obs/` — complete v2.0.0 C++ plugin with .pkg/.exe
  installer and CI/CD. Needs to be updated for the new Vercel-agent architecture.
- **Most of the self-serve SaaS is built** (agent, broker, billing, dashboard,
  crop editor). Remaining gaps: stream_sessions not yet recorded (stats/history
  show empty); OBS plugin not yet rebuilt for the agent architecture; end-to-end
  RunPod provision not yet verified live (gpuTypeId / dataCenterIds unconfirmed).
  Plan: `/Users/danielaltom/.claude/plans/alright-lets-plan-this-eventual-clover.md`

## Layout
- `relay/` — GPU server. supervisor.py + agent.py + app.py + mediamtx + hook.sh.
  agent.py is the Docker entrypoint (on-boot pair/poll/heartbeat).
- `web/` — Next.js app: auth, dashboard, platform config, credit billing, OBS dock,
  GPU availability broker. Stack: Next.js + Supabase + Stripe. Deploys to Vercel.
- `slimcast-obs/` — C++ OBS plugin (v2.0.0 complete). Manages relay from OBS.
- `docs/` — architecture notes and product plan (may be stale vs plan file above).

## Target user flow (the north star — nothing should require a terminal)
1. Sign up → onboarding wizard auto-starts
2. Paste stream keys for desired platforms (Twitch/Kick/YouTube/TikTok)
3. Onboarding shows the SlimCast API key once → paste into OBS plugin
4. Download OBS plugin (.pkg Mac / .exe Windows) → double-click to install
5. Open OBS → SlimCast panel present → enter SlimCast API key once → done
6. **Every stream:** click Start Streaming in OBS → the broker provisions the
   nearest available GPU (~45s), all platforms go live automatically; clicking
   Stop destroys the pod (no idle billing).
7. **Low credits:** OBS plugin warns at 30 min left → hard stop at zero
   (enforced on the agent heartbeat, burn-rate aware).

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
   encode paths. CPU is used only for the portrait crop+scale (low-bitrate,
   acceptable). YouTube landscape is `-c copy` HEVC passthrough — no encode.

5. **Vercel stores config, GPU executes it.** Platform RTMP keys live in Supabase,
   never in the Docker image. The GPU agent polls Vercel every 10s for config
   and streams it into supervisor.apply(). One SLIMCAST_API_KEY env var on the pod
   is the only credential it needs.

6. **OBS plugin talks to Vercel, not the GPU.** Plugin authenticates with user's
   API key against slimcast.com/api/agent/*. GPU IP never touches the plugin.

7. **Grouped transcode + tee fan-out (NOT one transcode per platform).** Per pod
   there are at most three processes: (a) one landscape NVENC encode tee'd to all
   landscape platforms, (b) one portrait encode (user crop → 9:16) tee'd to all
   portrait platforms, (c) per-output HEVC passthrough (YouTube landscape). The
   `tee` muxer copies the finished bitstream to each destination with
   `onfail=ignore` so one platform dropping never disturbs the others. This is why
   platforms in the same group **share one bitrate** (the group runs at the lowest
   cap in it). Do not revert to per-platform full transcodes.

8. **GPU is chosen by the availability broker, never by hand.** `lib/gpu-broker.ts`
   cascades over {provider × datacenter × GPU-type} ranked by latency tier
   (geo-nearest first via Vercel geo headers) then price, until a pod boots.
   NVENC-only catalog, hard $1/hr ceiling (catalog filter + runtime cost guard),
   readiness gate (abandon pods that don't get an IP). Provider-abstracted —
   RunPod today; Vultr/Vast.ai drop in as more entries. Tuning surface:
   `lib/datacenters.ts`.

9. **Billing runs on the pod agent heartbeat.** burn rate = 1 token/hr base
   (incl. YouTube passthrough + first transcode) + 0.2/extra transcoded platform.
   The pod agent's heartbeat (label='pod') is the billing clock and the only thing
   that deducts; the dashboard/OBS dock poll the same endpoint with the user key
   and must never deduct. See `lib/billing.ts`.

## Key files
### relay/
- `supervisor.py` — `plan_runners()` groups enabled outputs by orientation +
  passthrough; `build_group_cmd()` = 1 decode → 1 NVENC encode → tee fan-out;
  `build_passthrough_cmd()` = HEVC copy → HLS/fMP4 (YouTube); `portrait_crop_rect()`
  turns user zoom/pos into an FFmpeg crop. OutputRunner (auto-restart + backoff),
  Supervisor (apply/stop_all/grace-period). Quality flags: **p6**/hq/fullres, CBR,
  2x bufsize, bf=3, rc-lookahead=32, spatial/temporal-aq. Do not degrade these.
- `agent.py` — Docker entrypoint: pairs with Vercel, starts MediaMTX + uvicorn,
  polls config (outputs + crop) every 10s, posts heartbeats, runs control commands.
- `app.py` — FastAPI control plane (kept for debug; agent wraps it).
- `mediamtx.yml` — RTMP :1935 ingest + SRT :8890 loopback; runOnReady → hook.sh.
- `hook.sh` — triggers supervisor start/stop-with-grace when OBS connects/drops.
- `Dockerfile` — nvidia/cuda:12.4.1-runtime-ubuntu22.04, jellyfin-ffmpeg 7.1.4-3,
  MediaMTX v1.9.3. CMD = python3 agent.py. Built/pushed to
  `ghcr.io/oxlynum/multistream-relay:latest` by `.github/workflows/relay-docker.yml`
  on any `relay/**` change.

### web/
- `lib/supabase.ts` — browser (SSR cookie) + server Supabase clients.
- `lib/stripe.ts` — Stripe client (lazy Proxy to survive build w/o key).
- `lib/runpod.ts` — RunPod REST wrapper (createPod w/ gpuType/cloud/dataCenterIds,
  stop/destroy/getPodStatus; returns costPerHr for the price guard).
- `lib/gpu-broker.ts` — availability cascade + ranking + readiness gate (Arch #8).
- `lib/datacenters.ts` — DC coords + NVENC GPU catalog + all broker policy knobs
  (PRICE_CEILING, latency tiers, CLOUD_TYPES). **Tune here, not in code.**
- `lib/providers/` — provider interface + RunPod impl + registry (Vultr/Vast TODO).
- `lib/billing.ts` — transcodeCount + burnRatePerSec (Arch #9).
- `lib/agent-config.ts` — shared output builder for config+pair routes (incl. the
  YouTube HLS passthrough URL from the stream key).
- `app/api/agent/*` — pair, config, status (billing clock), control.
- `app/api/gpu/*` — provision (geo → broker), stop, destroy (via provider registry).
- `app/api/platforms/`, `app/api/credits/*`, `app/api/portrait-crop/` — built.
- `app/dashboard/` — stats panel + live CostMeter + API key; `/platforms`,
  `/settings` (per-platform quality + portrait crop editor), `/credits`.
- `app/onboarding/`, `app/obs-dock/` (shows live cost meter), `middleware.ts` — built.
- `components/cost-meter.tsx`, `components/portrait-crop-editor.tsx`.

### slimcast-obs/
- Complete v1.0.0 C++ plugin. Has 3 tabs, CI/CD, .pkg/.exe installer.
- Needs: API key input replacing server IP; relay-api pointing to slimcast.com;
  cloud-provider.cpp removed; credit balance display. (NOT yet rebuilt for agent arch.)

## Platforms supported
| Platform | Protocol | Max kbps | Orientation | Encode |
|---|---|---|---|---|
| Twitch | RTMP | 8000 | Landscape | landscape tee group |
| Kick | RTMPS | 8000 | Landscape | landscape tee group |
| YouTube | HLS (fMP4) | source | Landscape* | **HEVC passthrough (no encode)** |
| TikTok | RTMP | 4500 | Portrait | portrait tee group (cropped 9:16) |

\* YouTube/TikTok can be set to portrait in settings → that output joins the
portrait (cropped) encode group instead. Facebook was dropped (its 4000 cap
dragged the shared landscape encode down; least popular). Re-add later via a
bitrate-tiered landscape grouping if wanted.

## Supabase schema
Tables: profiles, agent_api_keys, platform_connections, gpu_instances,
stream_sessions, achievements, agent_commands.
profiles cols: streaming_credits_seconds (default 7200), portrait_zoom/pos_x/pos_y.
gpu_instances cols: provider, gpu_type, datacenter, burn_rate, ip_address, status.
Migrations through `20260618000005_burn_rate.sql`. stream_sessions are NOT yet
written by anything (stats/history empty until session recording is wired).

## Codec roadmap
- HEVC ingest now; YouTube already gets HEVC passthrough. AV1 output later
  (needs Ada GPU — RTX 40/L4/L40, NOT Ampere).
- Audio: re-encoded AAC 160k in transcode groups; copied in YouTube passthrough.

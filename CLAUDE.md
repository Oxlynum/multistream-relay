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
- OBS plugin in `slimcast-obs/` — v2.1.0 C++ plugin, rebuilt for the agent
  architecture: single scrollable dock, API-key-only auth, OBS-driven GPU
  lifecycle (Start Streaming → provision nearest GPU; Stop → destroy pod, no idle
  billing — NO manual GPU controls). Dock controls stream config (channel on/off,
  group bitrate caps) synced to the same Supabase rows as the website; res/fps
  shown read-only from OBS. cloud-provider/provider-presets removed. Builds +
  installs clean locally (CMake/Ninja); .pkg/.exe via CI.
- **Most of the self-serve SaaS is built** (agent, broker, billing, dashboard,
  crop editor, OBS plugin). stream_sessions are now recorded by the heartbeat
  (open on first streaming beat → accumulate duration/credits/platforms → close
  on stop or teardown), so stats/history populate. Remaining gap: end-to-end
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

10. **Pod safety is defense-in-depth — a rogue pod is the #1 financial risk.**
    A running pod bills RunPod 24/7, so destruction (not just stopping outputs)
    must happen on every failure path. Layers, each independent:
    - **Plugin**: OBS Stop → destroy; orphan auto-destroy (pod up + OBS not
      streaming for ~10s → destroy, catches reopened-after-crash).
    - **Heartbeat self-destruct** (`/api/agent/status`, pod only): tears the pod
      down on credits<=0, idle>5m (tracked via `idle_since`), or session>12h.
    - **Agent watchdogs** (`relay/agent.py`): stop outputs after ~60s of failed
      heartbeats (unsupervised); self-request `/api/agent/terminate` on idle>5m or
      session>12h.
    - **Cron reaper** (`/api/cron/reap`, daily via `web/vercel.json`): the backstop
      for pods that stop phoning home — destroys on stale heartbeat (>150s),
      never-paired (>180s), max-session, or idle. **Daily because Vercel Hobby
      caps crons at once/day** (every-minute schedules fail the build). Optional
      `CRON_SECRET` protects it. For minute-level reaping of dead-agent pods, go
      Pro or point an external pinger at the endpoint — the live-agent self-destruct
      already covers the common cases within seconds.
    - All teardown goes through `lib/pod-teardown.ts` `teardownInstance()`
      (idempotent: provider destroy + revoke pod key + delete row; best-effort so
      a provider error never strands the row).

11. **Stream keys must never reach the public — secret-handling rules.**
    - **Encrypted at rest** in `platform_connections.stream_key_encrypted` via
      `lib/crypto.ts` (AES-256-GCM, format `v1:iv:tag:ciphertext`). The key lives
      only in `STREAM_KEY_SECRET` (Vercel env) — a different trust domain than
      Supabase, so a DB dump alone is ciphertext. `POST /api/platforms` encrypts
      on write; `agent-config.ts` `decryptSecret()`s right before handing keys to
      the agent. `decryptSecret` passes non-`v1:` values through unchanged
      (legacy-plaintext fallback for rows written before encryption). **Losing
      `STREAM_KEY_SECRET` makes all stored keys unrecoverable** — back it up.
    - Only `/api/agent/{pair,config}` ever return keys, and only to an
      authenticated agent (pod/user key) over HTTPS. The dashboard GET routes and
      all browser queries select **everything except** the key column — keys never
      reach the client after the one-time POST that sets them.
    - Env split: only `NEXT_PUBLIC_{SUPABASE_URL,SUPABASE_ANON_KEY,APP_URL}` are
      public; service-role + Stripe secret + `STREAM_KEY_SECRET` are server-only;
      `.env*` is gitignored.
    - Relay: stream keys get embedded in the FFmpeg command + FFmpeg's stderr
      banner, so `supervisor._redact()` literal-scrubs every known key from the
      log ring buffer (refreshed each `apply()` via `_register_secrets`). The
      FastAPI debug panel (`app.py`, key-bearing `/api/logs`) is **not** exposed
      publicly — RunPod pods open `1935/tcp` only (see `runpod.ts`), and the panel
      fails closed without `RELAY_PASSWORD`.

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
- `app/api/agent/*` — pair, config, status (billing clock + safety self-destruct),
  control, terminate (pod self-requested teardown).
- `app/api/cron/reap/` — every-minute reaper (stale/never-paired/idle/max-session).
- `lib/pod-teardown.ts` — `teardownInstance()`, the one idempotent destroy path.
- `web/vercel.json` — cron schedule for the reaper.
- `app/api/gpu/*` — provision (geo → broker), stop, destroy (via provider registry).
  All accept `authenticateUserOrAgent` (dashboard session OR OBS API key) so the
  dock can drive the GPU lifecycle.
- `app/api/encode/` — GET+PATCH the per-group bitrate caps (authenticateUserOrAgent;
  shared by dashboard settings + OBS dock).
- `app/api/platforms/` — GET + PATCH accept agent keys too (dock toggles channels);
  POST/DELETE stay session-only (need stream key). `credits/*`, `portrait-crop/` built.
- `lib/agent-auth.ts` — `authenticateUserOrAgent()`: agent key first, then Supabase
  JWT. The shared resolver for routes both the dock and dashboard call.
- `app/dashboard/` — stats panel + live CostMeter + API key; `/platforms`,
  `/settings` (group bitrate caps + orientation + portrait crop; fps/res are
  OBS-owned, not editable), `/credits`.
- `app/onboarding/`, `app/obs-dock/` (shows live cost meter), `middleware.ts` — built.
- `components/cost-meter.tsx`, `components/portrait-crop-editor.tsx`.

### slimcast-obs/
- v2.1.0 C++ plugin, rebuilt for the agent architecture. CI/CD, .pkg/.exe.
- `relay-api.cpp/hpp` — all calls to slimcast.com with Bearer API key. GpuInfo
  carries status/ip/rtmpUrl/credits/burnRate/streaming + per-platform states
  (flattened from grouped `outputs`). Methods: fetchGpuStatus, provisionGpu,
  destroyGpu (DELETE /api/gpu — no idle billing).
- `relay-dock.cpp/hpp` — single status-first QStackedWidget dock (setup page →
  active page). **No manual start/stop, no tabs:** lifecycle is 100% OBS-driven
  (STREAMING_STARTING → provision + wait + set ingest URL + resume; STREAMING_STOPPED
  → destroy). **No manual GPU controls of any kind** — GPU start/stop is
  exclusively OBS-driven (product rule). The dock IS a control panel for stream
  config though: per-channel on/off toggles (PATCH enabled; applies mid-stream
  in ≤10s), a channel-lock that auto-engages on stream start, per-encode-group
  bitrate cap sliders (PATCH /api/encode), live per-platform dots, faint
  per-channel + total token-rate fine print. Resolution/fps are read-only,
  pulled from OBS via obs_get_video_info (never editable — OBS owns them).
  Everything the dock changes is the same Supabase config the website edits, so
  dock ↔ slimcast.com stay in sync.
- OBS-driven flow depends on the MediaMTX ingest hook to start outputs once OBS
  pushes RTMP — the plugin no longer sends start/stop control commands (those
  remain for the dashboard via /api/agent/control).

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
profiles cols: streaming_credits_seconds (default 7200), portrait_zoom/pos_x/pos_y,
landscape_bitrate_kbps (default 6000), portrait_bitrate_kbps (default 4000) — the
per-encode-group bitrate caps (NOT per-platform; the GPU encodes once per
orientation, so agent-config writes the group cap onto every member output).
gpu_instances cols: provider, gpu_type, datacenter, burn_rate, ip_address, status,
outputs (jsonb), streaming (bool), idle_since (timestamptz), session_id (uuid →
stream_sessions, the pod's currently-open session). The pod heartbeat persists
outputs+streaming so `/api/gpu/status` can feed the dashboard + OBS plugin
per-platform dots.
stream_sessions are written by the heartbeat (`/api/agent/status`, pod only):
opened on the first streaming beat, duration/credits_deducted/platforms
accumulated each beat, closed (ended_at) when streaming stops or on
teardownInstance. Migrations through `20260622000001_session_recording.sql`.

## Codec roadmap
- HEVC ingest now; YouTube already gets HEVC passthrough. AV1 output later
  (needs Ada GPU — RTX 40/L4/L40, NOT Ampere).
- Audio: re-encoded AAC 160k in transcode groups; copied in YouTube passthrough.

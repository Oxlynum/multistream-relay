# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---
## ⚡ CLI TOOLS AVAILABLE IN THIS SESSION

| CLI | What it covers |
|-----|----------------|
| `vastai` | List/destroy/SSH into running Vast.ai GPU instances (`vastai show instances-v1 --raw`, `vastai logs <id>`, `vastai destroy instance <id> --yes`) |
| `gh` | GitHub — PRs, issues, CI status, release tags (`gh run list`, `gh pr create`, `gh release view`) |
| `supabase` | DB migrations, inspect tables, run SQL (`supabase db diff`, `supabase migration new`, `supabase db push`) |
| `vercel` | Deploy, logs, env vars (`vercel logs --environment=production --since=10m -x`, `vercel env pull`, `vercel --prod`) |

**Debug flow for a crashing pod:** `vastai show instances-v1 --raw` → `vastai logs <id> --tail 100`. The debug panel on `:8080` shows live FFmpeg stderr (uvicorn runs in-process with agent.py since 2026-06-26).

---

## What it is
**SlimCast** — consumer multistreaming SaaS. OBS pushes one HEVC stream from a Mac mini M4 to a cloud GPU; the GPU transcodes once per orientation and fans out to Twitch, Kick, YouTube, TikTok. Nothing requires a terminal.

**Business model:** pay-per-use credits. Base $2/hr (1 token), billed in seconds; +0.2 token/hr per extra transcoded platform. 2 free hours on signup.

## Current status
- Pipeline confirmed working end-to-end (Twitch at 1080p60).
- **Ingest is SRT-only (UDP).** No RTMP ingest path. UDP requirement is why Vast is the sole provider and RunPod is permanently removed (TCP-only, confirmed).
- **SRT latency: hardcoded 5000ms** (`&latency=5000` in `/api/gpu/status`). Do not lower — platform buffering (Twitch 3–8s, YouTube 5–30s) swallows the delay, and it gives low-bandwidth users jitter resilience.
- **Provider: Vast.ai only** (`ACTIVE_PROVIDERS = [vastProvider]`). Hard $1/hr all-in ceiling. **RunPod permanently removed** (TCP-only). **Vultr planned next** (UDP-capable, broader coverage).
- **NVENC driver regression (solved):** On multi-GPU hosts with driver ≥570, NVENC `OpenEncodeSessionEx` fails with `unsupported device` — NVIDIA bug, unfixable in our image (jellyfin 7.1.4-3, 8.1.1-4, and FFmpeg master all fail identically). Fix: Ada/Blackwell on driver ≥570 → `preferenceTier:1` (soft-demote, not exclude) in `lib/providers/vast.ts`; pod boot self-test is the hard gate. `MACHINE_DENYLIST` exists for genuinely broken machines and is separate from the driver regression fix.
- **Relay image: ~0.23GB** (`cuda -base`, not `-runtime` — CUDA toolkit is unused).
- Web app (Next.js 16) in `web/`; auth gate is `web/proxy.ts` (renamed from `middleware.ts` per Next 16).
- OBS plugin v2.1.0 in `slimcast-obs/` — OBS-driven lifecycle, no manual GPU controls.
- **Remaining gap:** OBS publishing `publish:<key>` SRT not yet verified live end-to-end.
  Plan: `/Users/danielaltom/.claude/plans/alright-lets-plan-this-eventual-clover.md`

## Layout
- `relay/` — GPU Docker image: `supervisor.py`, `agent.py`, `app.py`, MediaMTX, `hook.sh`
- `web/` — Next.js 16: auth, dashboard, billing, broker, OBS dock. Supabase + Stripe. Vercel.
- `slimcast-obs/` — C++ OBS plugin v2.1.0. CI builds .pkg/.exe.
- `docs/` — architecture notes (may be stale).

## Commands

**web/** (Next.js 16, deploys via Vercel on push to `main`):
```bash
cd web
npm run dev
npx tsc --noEmit          # pre-push gate — no test suite
vercel --prod             # run from repo root (Vercel root dir is web/)
vercel logs --environment=production --since=10m -x
```
> **Next.js 16:** before writing routing/caching/middleware/server-action code, read `web/node_modules/next/dist/docs/`. Auth gate is `web/proxy.ts`.

**slimcast-obs/** (macOS arm64, needs OBS.app + CMake ≥3.26):
```bash
cd slimcast-obs
cmake --preset macos-arm64
cmake --build --preset macos-arm64
cmake --install build/macos-arm64 --prefix "$HOME/Library/Application Support/obs-studio/plugins"
```
Install to the `.plugin` bundle ONLY — never `cp` into `bin/64bit` (duplicate dock). Windows: `windows-x64`. Restart OBS to load.

**relay/** — CI auto-builds on `relay/**` push to `main` → `ghcr.io/oxlynum/multistream-relay:latest` + `:<sha>` rollback tags. Manual promote: `docker buildx imagetools create --tag ...:latest ...:slim`.

**relay/** local testing:
```bash
cd relay
docker compose up --build   # requires RELAY_PASSWORD env; UDP/SRT ports not in compose — test SRT on real Vast pod
```

**One-time Stripe setup:**
```bash
cd web && STRIPE_SECRET_KEY=sk_... node scripts/setup-stripe.mjs
# Add printed price ID to Vercel as STRIPE_PRICE_HOURLY
```

**Probes** (always probe before trusting provider APIs — this repo has been bitten by assumed API shapes):
`web/scripts/test-vast.mjs` (offer search), `test-vast-rent.mjs` (rent→ports→destroy). Read keys from `web/.env.local`.

**Required env vars** (see `web/.env.example`):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_HOURLY`
- `SLIMCAST_RELAY_IMAGE`, `SLIMCAST_AGENT_CALLBACK_URL`
- `STREAM_KEY_SECRET` — AES-256-GCM; **losing it makes all stored keys unrecoverable**
- `VAST_API_KEY` (not in `.env.example` — add manually)
- `CRON_SECRET` (optional; protects `/api/cron/reap`)
- `TWITCH_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `FACEBOOK_APP_ID/SECRET`
- `SLIMCAST_DEV_NO_BILLING_USER_ID` — dev billing bypass (blank in prod)

## Working conventions (standing authorization — do these on wrap-up)
- **Update CLAUDE.md** when architecture, provider, schema, or load-bearing assumptions change.
- **Push to GitHub** after `npx tsc --noEmit` passes. Real commit message. (`relay/**` push triggers Docker CI.)
- **Apply Supabase migrations** (`supabase db push`) after editing SQL in `web/supabase/migrations/`.
- **Rebuild + reinstall OBS plugin** after any `slimcast-obs/` change; restart OBS.

Still confirm before destructive/irreversible actions (deleting data, force-push, live infra teardown).

## Target user flow
1. Sign up → onboarding
2. Paste platform stream keys; download OBS plugin (.pkg / .exe)
3. Enter API key in dock once
4. **Every stream:** Start Streaming in OBS → amber "Cancel" while broker provisions GPU (~45s) → all platforms go live automatically
5. Stop Streaming → pod destroyed (no idle billing)
6. OBS warns at 30 min credits remaining → hard stop at zero

## Architecture (load-bearing — read before changing)

1. **OBS → GPU: HEVC over SRT (UDP only).** No RTMP ingest. `srt://<pod>:<port>?streamid=publish:<key>`. UDP requirement rules out RunPod permanently. RTMP `:1935` binds on the pod only as a readiness beacon (TCP-provable from serverless); OBS never publishes to it.

2. **Internal loopback: SRT, not RTSP.** MediaMTX runs one SRT server on `:8890` — OBS publishes externally, FFmpeg reads loopback (`srt://127.0.0.1:8890?streamid=read:<key>`). RTSP mangles Apple's temporal-layered HEVC → dropped frames. Do not switch to RTSP.

3. **FFmpeg pinned to jellyfin-ffmpeg 7.1.4-3.** Do not change to chase NVENC failures on driver ≥570 hosts — that's a host driver bug (NVENC API backward-compat means no FFmpeg version fixes it). The preferenceTier + boot self-test handle it.

4. **Hardware codecs only.** NVDEC decode + NVENC H.264 encode. CPU only for portrait crop+scale. YouTube landscape = `-c copy` HEVC passthrough.

5. **Vercel stores config, GPU executes it.** Stream keys in Supabase; agent polls Vercel every 10s. One `SLIMCAST_API_KEY` env var on the pod.

6. **OBS plugin talks to Vercel, not the GPU.** GPU IP never reaches the plugin.

7. **Grouped transcode + tee fan-out.** At most 3 processes per pod: (a) one landscape NVENC encode → tee all landscape platforms, (b) one portrait encode → tee all portrait, (c) HEVC passthrough for YouTube. `onfail=ignore` — one platform drop doesn't affect others. Platforms in the same group share one bitrate. Do not revert to per-platform transcodes.

8. **GPU chosen by broker, never by hand.** `lib/gpu-broker.ts`. Ranks: `preferenceTier` → haversine distance → price; creates best-first until one boots. Hard $1/hr ceiling. Readiness gate: mapped SRT/UDP ports + RTMP beacon handshake. UDP echo (8889) advisory — reject only on explicit `ECHO:BAD`, never no-reply.
   - Registry: `lib/providers/index.ts` (`ACTIVE_PROVIDERS`, `getProvider()`).
   - Vast (`lib/providers/vast.ts`): Turing+ (`compute_cap >= 750`), ≤$8/TB egress, ≥300 Mbps, ≥3 direct ports. UDP ports need explicit `-p HOST:CONTAINER/udp` at create.
   - Vultr planned next. **RunPod cannot be re-added** (TCP-only, SRT ingest is mandatory).
   - Broker knobs: `lib/datacenters.ts` (`PRICE_CEILING`, readiness timeouts, `FALLBACK_LAT/LON`).

9. **Billing on heartbeat.** Base 1 token/hr. Adders: +0.2/extra landscape platform; +0.2/portrait on different orientation; +0.1/portrait dual-format; +0.5 for 1440p (`has_2k_addon`); +0.5 if >3 NVENC sessions (consumer GPUs cap at 3 — broker skips them). Only `label='pod'` heartbeat deducts; dashboard/dock never do. See `lib/billing.ts`, `lib/nvenc-utils.ts`. The 1440p adder is suppressed for any interval the pod has throttled below 1440p (`buildBillingContext(..., resolutionThrottledBelow1440)`) — don't bill 2K the user isn't getting.

9a. **Budget throttle: degrade, don't kill.** The flat user price hides a variable Vast bill (GPU + egress + ingress $/TB). The $1/hr broker ceiling is a provision-time *estimate*; live spend is uncapped (OBS source bitrate and YouTube HEVC passthrough follow whatever OBS sends). The pod closes that loop: `relay/budget.py` `CostMeter` reads `/proc/net/dev` each heartbeat (excludes `lo` — the SRT loopback isn't billed) and computes real $/hr from cost rates injected at provision (`SLIMCAST_GPU_RATE_USD`, `SLIMCAST_EGRESS_USD_PER_TB`, `SLIMCAST_INGRESS_USD_PER_TB`, `SLIMCAST_COST_CEILING_USD`). `BudgetController` maps cost → a quality tier (discrete ladder in `TIERS`) with **down-fast/up-slow hysteresis** (>ceiling → throttle a step; <85% for 3 beats → recover; 85–100% dead-band — prevents FFmpeg-restart flapping). Three levers, applied together per tier: (a) transcode bitrate caps + (b) resolution downscale (`scale_cuda` landscape / portrait scale) via `throttle_config` → `sup.apply()` (pod-local, ~0s); (c) **OBS source bitrate** — the only lever touching ingress + YouTube passthrough — reported as `suggested_ingest_kbps` in the heartbeat → surfaced in `/api/gpu/status` → plugin calls `obs_encoder_update()` on the live encoder (~15s end-to-end). Ceiling is **$1.50/hr for `has_2k_addon`, else $1.00**. Floor tier = the user's entitled resolution (controller never recovers above it). `SOURCE_WIDTH/HEIGHT` are set at provision from the user's max output resolution so the downscale guard knows the true source. This protects SlimCast's **margin**, not the user's bill — the user pays burn_rate regardless. **YouTube stays HEVC passthrough** (best quality/bit); never transcode it to "save" egress — the OBS source lever already caps it. Dock shows a calm "Live · quality auto-adjusted" when throttled.

10. **Pod safety: defense-in-depth.** A rogue pod is the #1 financial risk.
    - Atomic provision claim: row reserved before pod created → 409 on race. Requires saved card + credits.
    - Plugin: Stop → destroy; orphan auto-destroy after ~10s idle (catches OBS crash).
    - Heartbeat self-destruct: credits≤0, idle>5m (`idle_since`), or past `max_session_at`.
    - Agent watchdogs: stop outputs after ~60s missed heartbeats; self-request `/api/agent/terminate` on idle>5m.
    - Cron reaper (`/api/cron/reap`, daily): stale >150s, never-paired >180s, past-deadline, idle. Reconciles against all providers to catch true orphans. `CRON_SECRET` optional.
    - All teardown via `lib/pod-teardown.ts` `teardownInstance()` (idempotent: destroy + revoke key + delete row + close stream_session).

11. **Stream keys never reach the public.**
    - Encrypted at rest: AES-256-GCM in `platform_connections.stream_key_encrypted` (`lib/crypto.ts`). Only `/api/agent/{pair,config}` return decrypted keys. Dashboard queries exclude the key column.
    - Debug panel (`:8080`) is reachable on Vast — fails closed without `RELAY_PASSWORD`. Set it or drop 8080 from EXPOSE.
    - Only `NEXT_PUBLIC_*` vars are public; service-role + Stripe + `STREAM_KEY_SECRET` are server-only.

12. **12h cap is confirmable, not a hard kill.** `max_session_at` = now+12h at provision. Final 30m: status returns `confirm_required:true`; dock shows countdown + confirm button. Confirming extends 12h. Unconfirmed → heartbeat hard-kills → reaper backstops.

13. **Money paths are idempotent + rate-limited.** `credit_payment_once(payment_id,…)` deduped by Stripe payment ID (no double-credit on webhook retry). Sensitive routes: `checkRateLimit()` (Supabase fixed-window, fails open). Checkout price is server-side.

14. **Relay image: driver-level only, not CUDA toolkit.** All GPU surface (NVENC, NVDEC, hwaccel) mounted from host by NVIDIA container runtime. Base: `nvidia/cuda:12.4.1-base-ubuntu22.04`. `NVIDIA_DRIVER_CAPABILITIES` must include `video` + `compute` (set in Dockerfile; Vast may not set them implicitly). Rollback: `docker buildx imagetools create` to retag a known-good `:<sha>` to `:latest` (~2s).

## Key files

### relay/
- `supervisor.py` — groups outputs by orientation; `build_group_cmd()` = decode → (optional `scale_cuda` downscale) → NVENC → tee fan-out; `build_passthrough_cmd()` = HEVC copy for YouTube. `_group_max_height()` drives the budget downscale. Quality: p6/hq/fullres, CBR, 2x bufsize, bf=3, rc-lookahead=32. Do not degrade.
- `budget.py` — `CostMeter` (live $/hr from `/proc/net/dev`) + `BudgetController` (`TIERS` ladder, hysteresis) + `throttle_config()` (caps bitrate/resolution per tier). See architecture #9a.
- `agent.py` — Docker entrypoint: pairs with Vercel, starts MediaMTX + uvicorn in-process, polls config every 10s, posts heartbeats. Runs the budget controller each beat: applies transcode throttle via `sup.apply()`, reports cost + `suggested_ingest_kbps` in the heartbeat. Single throttle-aware apply path keyed on `(config_hash, tier)`.
- `app.py` — FastAPI debug panel on `:8080`. Requires `RELAY_PASSWORD` (fails-closed). Shares live Supervisor with agent.py.
- `mediamtx.yml` — SRT `:8890` (ingest + loopback) + RTMP `:1935` beacon. `runOnReady` → `hook.sh`.
- `Dockerfile` — `nvidia/cuda:12.4.1-BASE`, jellyfin-ffmpeg 7.1.4-3, MediaMTX. `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`. Image ~0.23GB.

### web/
- `lib/gpu-broker.ts` — ranked cascade, readiness gate, RTMP beacon + SRT/UDP checks.
- `lib/datacenters.ts` — broker knobs only (`PRICE_CEILING`, timeouts, `FALLBACK_LAT/LON`). Tune here.
- `lib/providers/index.ts` — `ACTIVE_PROVIDERS`, `getProvider()`. `lib/providers/vast.ts` — offer search, all-in pricing, UDP `-p` flags at create.
- `lib/billing.ts` — burn rate; `buildBillingContext` takes `resolutionThrottledBelow1440` to drop the 2K adder while throttled. `lib/nvenc-utils.ts` — `requiredNvencSessions()`.
- `lib/providers/vast.ts` `create()` injects per-pod cost env (`SLIMCAST_GPU_RATE_USD`/`_EGRESS_USD_PER_TB`/`_INGRESS_USD_PER_TB`) from the offer; `app/api/gpu/provision/route.ts` injects `SLIMCAST_COST_CEILING_USD` (1.5 if `has_2k_addon` else 1.0) + `SOURCE_WIDTH/HEIGHT`. Budget telemetry persists to `gpu_instances` (`cost_usd_hr`, `egress_gb_hr`, `ingress_gb_hr`, `suggested_ingest_kbps`, `throttle_tier`); `/api/gpu/status` surfaces them to the dock.
- `lib/agent-config.ts` — shared output builder for config+pair routes.
- `lib/pod-teardown.ts` — `teardownInstance()`, the only destroy path.
- `app/api/agent/*` — pair, config, status (billing clock + self-destruct), control, terminate.
- `app/api/gpu/*` — provision, stop, destroy. All accept `authenticateUserOrAgent`.
- `app/api/cron/reap/` — daily reaper. Schedule in `web/vercel.json`.
- `app/api/platforms/` — GET+PATCH accept agent keys; POST/DELETE session-only.
- `app/api/output-settings/` — per-platform resolution (720p/1080p/1440p) + bitrate. 1440p needs `has_2k_addon`.
- `app/api/metrics/connection/` — time-series inbound/outbound quality from `connection_metrics` (10s granularity, 120 min window).
- `lib/agent-auth.ts` — `authenticateUserOrAgent()`.
- `lib/oauth.ts`, `app/api/oauth/[platform]/` — platform OAuth (Twitch/YouTube/Facebook).
- `proxy.ts` — auth gate (renamed from `middleware.ts` per Next 16).

### slimcast-obs/
- `relay-api.cpp/hpp` — all slimcast.com API calls with Bearer key. `fetchGpuStatus`, `provisionGpu`, `destroyGpu`.
- `relay-dock.cpp/hpp` — single dock, OBS-driven lifecycle. No manual GPU controls (product rule). Per-channel toggles, bitrate sliders, live platform status dots.
- `HealthGraphWidget.cpp/h` — inbound + per-platform bitrate/health graph. Polls `/api/metrics/connection` every 10s; 60-sample history.
- `plugin-main.cpp` — registers Qt TLS backend (required for HTTPS), intercepts OBS stream button clicks, routes through provisioning flow.

## Platforms supported
| Platform | Protocol | Max kbps | Orientation | Encode |
|---|---|---|---|---|
| Twitch | RTMP | 8000 | Landscape | landscape tee group |
| Kick | RTMPS | 8000 | Landscape | landscape tee group |
| YouTube | HLS (fMP4) | source | Landscape* | HEVC passthrough |
| TikTok | RTMP | 4500 | Portrait | portrait tee group (9:16 crop) |

\* YouTube/TikTok can be set to portrait in settings. Facebook dropped (4000 cap dragged shared encode down).

## Supabase schema
Tables: `profiles`, `agent_api_keys`, `platform_connections`, `gpu_instances`, `stream_sessions`, `achievements`, `agent_commands`, `credited_payments`, `rate_limits`, `connection_metrics`, `device_link_codes`.

Key columns:
- `profiles`: `streaming_credits_seconds` (default 7200), `portrait_zoom/pos_x/pos_y`, `landscape_bitrate_kbps` (6000), `portrait_bitrate_kbps` (4000), `has_2k_addon`.
- `gpu_instances`: `provider` (default `'vast'`), `burn_rate`, `srt_port`, `session_id`, `max_session_at`, `idle_since`, `outputs` (jsonb), `streaming`, `cost_usd_hr`, `egress_gb_hr`, `ingress_gb_hr`, `suggested_ingest_kbps`, `throttle_tier` (budget throttle telemetry).
- `agent_api_keys`: service-role only (hashes never reach browser). Labels: `user`/`pod`/`device`.

Postgres fns: `credit_payment_once` (idempotent credit), `rate_limit_hit` (fixed-window).
Latest migration: `20260626000003_budget_throttle.sql` (adds budget-throttle telemetry columns to `gpu_instances`).

## OBS plugin account linking
- **Connect button (preferred):** PKCE OAuth — plugin opens browser to `/link`, user clicks Authorize → one-time code → plugin redeems at `POST /api/link/token` → per-device key issued. No key ever displayed.
- **Manual paste (fallback):** dashboard 'user' key pasted into dock.

## Codec roadmap
- AV1 output later (Ada only — RTX 40/L4/L40, not Ampere).
- Audio: AAC 160k in transcode groups; copied in YouTube passthrough.

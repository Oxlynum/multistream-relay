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

**Per-directory credential isolation (direnv):** CLI credentials auto-load when you `cd` into this directory — no `vercel logout/login`, `gh auth switch`, or `supabase login` needed. Tokens live in `.envrc` (gitignored). Linked accounts: GitHub `Oxlynum`, Vercel `oxlynum-5723`, Supabase `Oxlynum's Org`. To set this up in another project directory, tell the model: *"set up per-directory credential isolation with direnv"*.

**Debug flow for a crashing pod:** `vastai show instances-v1 --raw` → `vastai logs <id> --tail 100`. The debug panel on `:8080` shows live FFmpeg stderr (uvicorn runs in-process with agent.py since 2026-06-26).

**Diagnosing on a live Vast pod (hard-won, 2026-06-26):**
- **SSH in:** `vastai attach ssh <id> "$(cat ~/.ssh/id_ed25519.pub)"` (key takes ~30s to propagate), then `ssh -p <ssh_port> root@<ssh_host>` using `ssh_host`/`ssh_port` from `vastai show instance <id> --raw`. The host is `ssh<N>.vast.ai` (N varies — NOT always `ssh1`). `vastai execute` only runs on **stopped** instances; use SSH for running ones.
- **Vast injects the mapped public ports into the container as env:** `PUBLIC_IPADDR`, `VAST_TCP_PORT_1935`, `VAST_UDP_PORT_8890` (SRT), `VAST_UDP_PORT_8889` — a pod can build its own public SRT URL with zero cloud round-trips. Also drops `/root/.vast_api_key` (pod can self-destruct via Vast API).
- **`vercel logs` does NOT capture a long-running provision function's output** — it's buffered and lost when the function overruns `maxDuration`. Debug provisioning via `vastai logs <id>` / pod SSH, not Vercel logs.
- **Test SRT ingest externally** (Homebrew ffmpeg lacks libsrt): `brew install srt`, then `srt-live-transmit "udp://:8899?mode=listener" "srt://<ip>:<hostport>?passphrase=<pp>&streamid=publish:<key>&pbkeylen=16&latency=5000"` fed by `ffmpeg … -c:v hevc_videotoolbox -f mpegts udp://127.0.0.1:8899`. Confirmed reaching MediaMTX through Vast UDP forwarding.

---

## What it is
**SlimCast** — consumer multistreaming SaaS. OBS pushes one HEVC stream from a Mac mini M4 to a cloud GPU; the GPU transcodes once per orientation and fans out to Twitch, Kick, YouTube, TikTok. Nothing requires a terminal.

**Business model:** two-tier (Phase 3, behind `SLIMCAST_BILLING_ACTIVE`, default OFF). **PAYG:** buy tokens (1 token = 1 hr base transcode = $2); passthrough 0.1 tok/hr, transcode 1.0 + adders. **Subscription $20/mo:** monthly token allotment (15, rolls over capped at 30) + passthrough 0.05 tok/hr (cheaper but **never free** — a 24/7 idle passthrough still burns VPS bandwidth). Spendable = allotment (spent first) + purchased balance. 2 free tokens on signup. Kill-on-empty is **uniform** across plans (stream stops when spendable ≤ 0). Full model: `memory/phase3_billing_model.md`.

## Current status
- Pipeline confirmed working end-to-end (Twitch at 1080p60).
- **Ingest is SRT-only (UDP).** No RTMP ingest path. UDP requirement is why Vast is the sole provider and RunPod is permanently removed (TCP-only, confirmed).
- **SRT latency: hardcoded 5000ms** (`&latency=5000` in `/api/gpu/status`). Do not lower — platform buffering (Twitch 3–8s, YouTube 5–30s) swallows the delay, and it gives low-bandwidth users jitter resilience.
- **Provider: Vast.ai only** (`ACTIVE_PROVIDERS = [vastProvider]`). **$0.50/hr ceiling for 1080p, $1.00/hr for 2K** (`has_2k_addon`). **RunPod permanently removed** (TCP-only). **Vultr planned next** (UDP-capable, broader coverage).
- **NVENC driver regression (solved):** On multi-GPU hosts with driver ≥570, NVENC `OpenEncodeSessionEx` fails with `unsupported device` — NVIDIA bug, unfixable in our image (jellyfin 7.1.4-3, 8.1.1-4, and FFmpeg master all fail identically). Fix: Ada/Blackwell on driver ≥570 → `preferenceTier:1` (soft-demote, not exclude) in `lib/providers/vast.ts`; pod boot self-test is the hard gate. `MACHINE_DENYLIST` exists for genuinely broken machines (currently empty — hardcoded entries cleared 2026-06-27; use `VAST_MACHINE_DENYLIST` env var for ad-hoc blocking).
- **TCP egress decoupling (2026-06-27):** RTMPS output to Twitch is TCP; without `use_fifo`, TCP backpressure on the write socket blocks the entire FFmpeg encode loop — causing 5–10s near-zero egress gaps and viewer freezes. `use_fifo=1` in `_tee_targets()` fixes this. The egress sawtooth (CUBIC congestion window) is normal and does not cause viewer freezes; the severe drops (near-zero for a full 10s window) were encoder stalls, now fixed.
- **Relay image: ~0.23GB** (`cuda -base`, not `-runtime` — CUDA toolkit is unused).
- Web app (Next.js 16) in `web/`; auth gate is `web/proxy.ts` (renamed from `middleware.ts` per Next 16).
- OBS plugin v2.1.0 in `slimcast-obs/` — OBS-driven lifecycle, no manual GPU controls.
- **SRT ingest path PROVEN (2026-06-26):** external SRT push from a laptop, through Vast's UDP forwarding, into MediaMTX connects + authenticates (passphrase) + routes by streamid + fires the `runOnReady` hook. Loopback also verified. **The SRT/transcode layer is healthy — not the source of stream-start failures.**
- **Broker v2 shipped (2026-06-27):** replaced the RunPod-shaped synchronous cascade with a Vast-native design: (1) pods **push** readiness via `POST /api/agent/ready` / `/failed` instead of being probed from serverless; (2) provision fans out **N=2 pods in parallel** (first-ready-wins CAS); (3) provision route returns **202 in ~5s** instead of holding the cascade in a 300s request. Phase 0 stopgap also in: `MAX_BOOT_ATTEMPTS` 5→2, `READINESS_TIMEOUT_MS` 180s→110s, RTMP probe 3×10s→2×3s, fast-fail on terminal Vast states, `sweepStalePods` fire-and-forget. Enable: `SLIMCAST_BROKER_V2=true` (default ON). Roll back: `SLIMCAST_BROKER_V2=false`. Full design: `vastbroker-v2.md` (repo root).
- **End-to-end stream confirmed working (2026-06-27):** First successful full stream — OBS → SRT → RTX 3080 Ti → NVENC → Twitch live. Consumer Ampere whole-GPU pool (~$0.05–0.20/hr) is the active host pool.
- **Relay self-test frame size: 320×240.** NVENC on drivers ≥550 rejects frames below its minimum dimension. `128×128` (old size) failed on every GPU type tested. `320×240` is safe across all known driver versions. Do not lower this in `agent.py`.
- **GPU filter: consumer GPUs require `gpu_frac >= 1.0`** (MPS time-slicing fails CUDA device injection). Data center GPUs (A100/H100/L40/A10/A40/etc.) allow any `gpu_frac` (hardware MIG). Filter lives in `lib/providers/vast.ts`.
- **Broker race condition (fixed 2026-06-27):** `onRacerCreated` fired concurrently for both round-1 pods, each doing read-modify-write on the `racers` jsonb column — second write silently overwrote the first, leaving one pod invisible. When the visible pod failed, broker declared "all dead" and rotated the key, leaving the invisible pod unable to pair. Fixed by chaining `onRacerCreated` writes on a promise lock in both `provision/route.ts` and `agent/failed/route.ts`.
- **Universal termination lease (Phase 1, shipped 2026-06-28):** Closed the orphaned-Hetzner-hub incident class. Root cause: `vps_hubs.session_count` was a STORED counter — a single lost `detach_from_hub` call (un-try/catched after CASCADE delete) stranded it > 0 permanently → hub matched no kill condition → billed hourly forever. Fix: `session_count` DROPPED; hub occupancy is now DERIVED from live `renew_deadline` leases (`hub_active_tenant_count` fn). Two timers: `BOX_LEASE_MS=120s` (rides datacenter link, not user uplink) for boxes; `RECONNECT_GRACE_MS=180s` (OBS-source-presence gated) for VPS-hub tenants. One universal sweeper `sweepExpiredLeases()` covers all 3 billable kinds, fired heartbeat-driven from every role. `claim_hub_for_teardown` RPC is the race-safe drain barrier. Relay `DISCONNECT_GRACE_S` raised 20s→180s + auto-resume fix for heartbeat-recovery with OBS still connected. Migration: `000009_universal_lease.sql`. **Hardening (`000010_lease_hardening.sql`, shipped 2026-06-28, after a 21-agent adversarial review):** (1) `SWEEP_GRACE_MS`=90s settle margin — a lease must be expired BOX_LEASE+grace (~210s) before reaping, so a post-outage heartbeat herd re-renews before anything dies (a 3-min control-plane blip never even flags a box); (2) `PROVISION_LEASE_MS`=300s boot lease stamped at the claim INSERT + `/ready` CAS so a box that boots but dies pre-first-heartbeat is swept in ~5min, not at the 12h cap; attach now seeds a 300s boot lease (was 180s) covering hub spawn, refreshed on promotion; (3) the sweep's DELETEs **atomically re-validate the lease in the predicate** (`expectLeaseBefore`/`expectLeaseNull` on `teardownInstance`, applied to both the gpu_instances and relay_nodes paths; `requireLeaseExpired` re-reads `renew_deadline` under the `claim_hub_for_teardown` row lock — TOCTOU fix so a hub that recovered after the sweep snapshot is NOT hard-destroyed); (4) the sweep runs via Next 16 `after()` (post-response — it is the PRIMARY reaper, no longer a freezable floating promise); (5) vps-broker destroys an orphan racer if the parent node CASCADE-vanished mid-write; (6) the lease RPCs are `service_role`-only.
- **Provider universality (Phase 2, shipped 2026-06-28):** Made the termination path provider-blind so a 2nd VPS/GPU provider (Vultr next) needs **zero new watchdog/reaper code**. (1) **Killed "blank = Vast":** `getProvider`/`getVpsProvider` are now **strict** — a blank/unknown/wrong-kind name THROWS (was: silent `?? 'vast'` fallback that routed a non-Vast box's destroy to Vast's API → no-op → leak). Every box stamps `provider` **at create** (`vps-broker.ts` `onRacerCreated`; the N=1 backend race means the sole racer is the eventual winner); migration `000011` backfills legacy blanks (`gpu_instances`→`vast`, `relay_nodes`→from its own `racers[]`, `vps_hubs`→`hetzner`). (2) **One registry:** `lib/providers/index.ts` collapsed to a single `REGISTRY` (kind+roles); the three `ACTIVE_*` arrays are DERIVED; `resolveProvider(kind,name)` is the one resolver (`getProvider`/`getVpsProvider` delegate). (3) **Generic managed identity:** `lib/managed-identity.ts` (`MANAGED_BY` + `podName`/`hubName` builders + `ownerOfPodName`/`ownerOfHubName` parsers) is the single source for the row-less orphan reconcile; `listInstances()` widened to `{id,name,ownerId}` (hub-EXCLUSIVE filter `ownerOfPodName != null`, so a hub never surfaces in the GPU reaper pass and get destroyed); the reaper dropped all name-prefix slicing; RunPod `listPods` gained the missing API-key guard. (4) **Generic aux-resource release:** Hetzner labels the primary IP `managed-by:slimcast` at create; new `VpsProvider.releaseAux()` + a reaper sweep release **orphaned (server-gone) unassigned primary IPs** — the one billable resource invisible to `listInstances` (closes the ~€0.50/mo-forever leak the old `hetzner.ts:238` comment promised but never had). (5) **Provider-neutral relay:** `agent.py` reads the GPU bridge port via a `*_TCP_PORT_8899` env scan (not hardcoded `VAST_`/`RUNPOD_`) + `SLIMCAST_PROVIDER`/`PROVIDER_ID` self-id. (6) **Account deletion:** `teardownAllForUser()` (the pre-delete hook — destroys every box BEFORE the `profiles→gpu_instances→relay_nodes` CASCADE drops the rows, else they leak) + `app/api/account/delete/route.ts` (session-auth only; **blocks while purchased `streaming_credits` remain unless `forfeitBalance` acknowledged**; **idempotent** Stripe cancel — already-canceled/missing sub treated as success so a stale id can't strand erasure; then `auth.admin.deleteUser` cascades) + a dashboard "Danger zone" (type-`DELETE` + forfeit checkbox). Verified: 17/17 `tsx` unit tests, migration tested idempotent+convergent on throwaway PG, `tsc` clean, billing 22/22 unchanged, **10-agent adversarial review** (2 real findings fixed: idempotent Stripe cancel + hub-exclusive GPU filter). **Phase 3 (box-local OS self-kill / injected provider creds) is explicitly OUT of scope** per the locked interview decision — boxes stay key-free; the heartbeat-driven sweep means any live box reaps the dead ones, so the only residual risk (a total, prolonged Vercel outage) is accepted.

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
npx tsc --noEmit              # pre-push gate (no Jest/Vitest in this repo)
npm run lint                  # eslint
npx tsx scripts/test-billing.ts   # billing-math unit tests (node:assert; exits non-zero on fail)
vercel --prod                # run from repo root (Vercel root dir is web/)
vercel logs --environment=production --since=10m -x
```
> **Next.js 16:** before writing routing/caching/middleware/server-action code, read `web/node_modules/next/dist/docs/`. Auth gate is `web/proxy.ts`.
>
> **Tests:** no test framework — tests are standalone `scripts/*.ts` run with `npx tsx` (each `node:assert`s and exits non-zero on failure; run one by invoking its file). To test **SQL migrations/RPCs** without touching prod, apply them to a throwaway Postgres and assert in PL/pgSQL: `docker run -d --name pgt -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17` (the image self-restarts once during initdb — wait for 3 consecutive `pg_isready`), then pipe `cat bootstrap.sql migrations/*.sql assert.sql | docker exec -i pgt psql -v ON_ERROR_STOP=1 -U postgres -d <db>`. Reconcile migrations must be idempotent + convergent on BOTH the live schema AND a fresh history replay — test both.

**slimcast-obs/** (macOS arm64, needs OBS.app + CMake ≥3.26):
```bash
cd slimcast-obs
cmake --preset macos-arm64
cmake --build --preset macos-arm64
cmake --install build/macos-arm64 --prefix "$HOME/Library/Application Support/obs-studio/plugins"
```
Install to the `.plugin` bundle ONLY — never `cp` into `bin/64bit` (duplicate dock). Windows: `windows-x64`. Restart OBS to load.

**relay/** — CI auto-builds on `relay/**` push to `main` → `ghcr.io/oxlynum/multistream-relay:latest` + `:<sha>` rollback tags. **CI also auto-pins `SLIMCAST_RELAY_IMAGE` in Vercel to the new SHA and redeploys** — no manual step needed. Requires `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` GitHub repo secrets (already set). Manual promote: `docker buildx imagetools create --tag ...:latest ...:slim`.

> **Never use `:latest` for `SLIMCAST_RELAY_IMAGE`.** GHCR CDN caches manifest lookups; Vast hosts resolve `:latest` at create-time and pin to the cached digest. Pods will pull stale images even minutes after a new push. The CI automation handles this — after any relay change just push to main and CI pins the correct SHA automatically.

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
- `SLIMCAST_BROKER_V2` — `true` (default, v2 push-readiness+race) / `false` (v1 cascade fallback)
- `SLIMCAST_VPS_HUB` — `false` (default) / `true` enables the VPS-as-the-Hub path (Phases 0–4 built; pending its consolidated live debug — see `vps-hub-plan.md`)
- `HETZNER_API_TOKEN` — Hetzner Cloud Read+Write token for the VPS hub provider (`lib/providers/hetzner.ts`) + `scripts/test-hetzner.mjs` + `scripts/build-hetzner-snapshot.mjs`. Not in `.env.example` git (ignored) — add manually.
- `HETZNER_SNAPSHOT_ID` — (Phase 4) pre-baked snapshot image id (Docker + relay image baked) → hubs boot in seconds; cloud-init skips apt+pull. Unset (default) = full install cloud-init (prod-unchanged). Build/refresh with `node scripts/build-hetzner-snapshot.mjs` after any relay-image change. `lib/providers/hetzner.ts` + `lib/cloud-init.ts`.
- `HETZNER_MIN_INCLUDED_TRAFFIC_TB` — (Phase 4) traffic-bundle floor (default 18) that pins hubs to Hetzner's 20 TB-bundle locations (EU). Drops the 1 TB US/SG locations + old low-bundle lines (per-location `included_traffic`). EU-only by economics; SRT's 5000ms buffer absorbs the transatlantic first-leg RTT (quality-safe). Optional hard pin: `HETZNER_ALLOWED_REGIONS=fsn1,nbg1,hel1`.

## Working conventions (standing authorization — do these on wrap-up)
- **Update CLAUDE.md** when architecture, provider, schema, or load-bearing assumptions change.
- **Push to GitHub** after `npx tsc --noEmit` passes. Real commit message. (`relay/**` push triggers Docker CI.)
- **Apply Supabase migrations** (`supabase db push`) after editing SQL in `web/supabase/migrations/`. **Run the `supabase` CLI from `web/`** — the linked project (`web/supabase/.temp`) + the real migrations live there. The repo root has a stray empty `supabase/` dir, so running the CLI from root makes `migration list` look empty and won't find your migrations. `supabase db dump --schema public -f <file>` is the way to read the TRUE live schema (the migration history does NOT reproduce prod — see the §2.3 credit drift). Prefer `--dry-run` before a real `db push`.
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

7. **Grouped transcode + tee fan-out.** At most 3 processes per pod: (a) one landscape NVENC encode → tee all landscape platforms, (b) one portrait encode → tee all portrait, (c) HEVC passthrough for YouTube. `onfail=ignore` — one platform drop doesn't affect others. `use_fifo=1` on each tee output — each RTMP destination runs in its own thread with a 512-frame queue so TCP backpressure on one platform (e.g. Twitch slowing ACKs) cannot stall the encoder. Platforms in the same group share one bitrate. Do not revert to per-platform transcodes.

8. **GPU chosen by broker, never by hand.** `lib/gpu-broker.ts`. Ranks: `preferenceTier` → haversine distance → price. Hard $1/hr ceiling. **Broker v2 (default, `SLIMCAST_BROKER_V2=true`):** provision fans out N=2 pods in parallel (`startProvisionRace()`), returns 200 in ~5s, and waits for pods to self-report via `POST /api/agent/ready` (CAS winner) / `POST /api/agent/failed` (kick next round). Wall-clock = fastest of N boots, not sum of serial failures. Bad hosts known in ~1s (agent exits immediately on GPU failure + POSTs /failed) instead of ~60–180s probe timeout. **v1 path (`SLIMCAST_BROKER_V2=false`):** synchronous cascade with Phase 0 improvements: 2 attempts × 110s timeout, 2×3s RTMP probe, early URL save via `onAddrKnown`, fast-fail on terminal Vast states.
   - Registry: `lib/providers/index.ts` (`ACTIVE_PROVIDERS`, `getProvider()`).
   - Vast (`lib/providers/vast.ts`): Turing+ (`compute_cap >= 750`), ≤$8/TB egress, ≥300 Mbps, ≥3 direct ports. UDP ports need explicit `-p HOST:CONTAINER/udp` at create.
   - Vultr planned next. **RunPod cannot be re-added** (TCP-only, SRT ingest is mandatory).
   - Broker knobs: `lib/datacenters.ts` (`PRICE_CEILING`, readiness timeouts, `FALLBACK_LAT/LON`).

9. **Billing on heartbeat (two-tier, Phase 3).** Single source of truth = `lib/billing.ts` `billingLineItems()` (feeds BOTH `computeBurnRate` deduction AND `buildPricingBreakdown` UI — they can't drift). **Passthrough group** (YouTube HLS + eligible-Twitch eRTMP + future): ONE flat charge, not per-platform — 0.05 tok/hr subscriber / 0.1 PAYG. **Transcode:** base 1.0 + 0.2/extra landscape + 0.2/portrait-different + 0.1/portrait-dual + 0.5 1440p (`has_2k_addon`, suppressed while throttled below 1440p) + 0.5 if >3 NVENC. **Deduction** = `lib/billing-clock.ts` `billStreamInterval()` → `deduct_tokens` RPC (allotment-first, then purchased, `FOR UPDATE` row lock). Two clocks call it: the `label='pod'` all-in-one heartbeat AND the VPS hub **Clock A** (`handleVpsStatus`, per-tenant, batch-loaded). GPU-backend heartbeat = telemetry only; dashboard/dock polls never deduct. All gated on `SLIMCAST_BILLING_ACTIVE` (default OFF = free). Kill-on-empty when `spendable ≤ 0` (allotment+purchased). See `lib/nvenc-utils.ts` `requiredNvencSessions()`.

9a. **Budget throttle: degrade, don't kill.** The flat user price hides a variable Vast bill (GPU + egress + ingress $/TB). The $1/hr broker ceiling is a provision-time *estimate*; live spend is uncapped (OBS source bitrate and YouTube HEVC passthrough follow whatever OBS sends). The pod closes that loop: `relay/budget.py` `CostMeter` reads `/proc/net/dev` each heartbeat (excludes `lo` — the SRT loopback isn't billed) and computes real $/hr from cost rates injected at provision (`SLIMCAST_GPU_RATE_USD`, `SLIMCAST_EGRESS_USD_PER_TB`, `SLIMCAST_INGRESS_USD_PER_TB`, `SLIMCAST_COST_CEILING_USD`). `BudgetController` maps cost → a quality tier (discrete ladder in `TIERS`) with **down-fast/up-slow hysteresis** (>ceiling → throttle a step; <85% for 3 beats → recover; 85–100% dead-band — prevents FFmpeg-restart flapping). Three levers, applied together per tier: (a) transcode bitrate caps + (b) resolution downscale (`scale_cuda` landscape / portrait scale) via `throttle_config` → `sup.apply()` (pod-local, ~0s); (c) **OBS source bitrate** — the only lever touching ingress + YouTube passthrough — reported as `suggested_ingest_kbps` in the heartbeat → surfaced in `/api/gpu/status` → plugin calls `obs_encoder_update()` on the live encoder (~15s end-to-end). Ceiling is **$1.00/hr for `has_2k_addon`, else $0.50**. Floor tier = the user's entitled resolution (controller never recovers above it). `SOURCE_WIDTH/HEIGHT` are set at provision from the user's max output resolution so the downscale guard knows the true source. This protects SlimCast's **margin**, not the user's bill — the user pays burn_rate regardless. **YouTube stays HEVC passthrough** (best quality/bit); never transcode it to "save" egress — the OBS source lever already caps it. Dock shows a calm "Live · quality auto-adjusted" when throttled.

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
- `supervisor.py` — groups outputs by orientation; `build_group_cmd()` = decode → (optional `scale_cuda` downscale) → NVENC → tee fan-out; `build_passthrough_cmd()` = HEVC copy for YouTube. `_group_max_height()` drives the budget downscale. Quality: **p7/hq/fullres, CBR, 2× bufsize, bf=2, forced-idr=1, aq-strength=8, rc-lookahead=32**. Do not degrade. `_tee_targets()` uses `use_fifo=1:fifo_options=queue_size=512,drop_pkts_on_overflow=1` — this decouples the encoder thread from TCP backpressure on each RTMPS output (without it, a TCP stall on the Twitch connection blocks the entire encode loop). **NVENC flag landmines:** `-weighted_pred 1` causes exit=234 (EINVAL) on RTX 4090 with jellyfin-ffmpeg 7.1.4-3 — do not add it. `-forced-idr 1` is safe and prevents scene-cut keyframe spikes. **TLS-bridge landmine (the bug that kept the VPS-hub Twitch bridge dark, fixed 2026-06-28):** the GPU's mpegts-over-TLS listener (`tls://0.0.0.0:8899?listen=1`) MUST receive its cert via ffmpeg **input options** `-cert_file/-key_file` (emitted by `_input_args()` when the tls source has `listen=1`) — ffmpeg's tls SERVER **ignores `cert_file`/`key_file` passed in the URL query**, so it offers no certificate and every handshake dies with `no shared cipher` → the GPU transcode ffmpeg exits → crash-loop → the hub's `source_forward` sees `connection refused`. Do NOT move the cert back into the URL. The client side (hub `source_forward`) needs no `verify=0` (ffmpeg's tls client doesn't verify by default). Verified empirically on jellyfin-ffmpeg 7.1.4-3.
- `budget.py` — `CostMeter` (live $/hr from `/proc/net/dev`) + `BudgetController` (`TIERS` ladder, hysteresis) + `throttle_config()` (caps bitrate/resolution per tier). See architecture #9a.
- `agent.py` — Docker entrypoint: pairs with Vercel, starts MediaMTX + uvicorn in-process, polls config every 10s, posts heartbeats. Runs the budget controller each beat: applies transcode throttle via `sup.apply()`, reports cost + `suggested_ingest_kbps` in the heartbeat. Single throttle-aware apply path keyed on `(config_hash, tier)`.
- `app.py` — FastAPI debug panel on `:8080`. Requires `RELAY_PASSWORD` (fails-closed). Shares live Supervisor with agent.py.
- `mediamtx.yml` — SRT `:8890` (ingest + loopback) + RTMP `:1935` beacon. `runOnReady` → `hook.sh`.
- `Dockerfile` — `nvidia/cuda:12.4.1-BASE`, jellyfin-ffmpeg 7.1.4-3, MediaMTX. `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`. Image ~0.23GB. EXPOSE includes **8888/tcp** (HLS preview player) — TCP ports come free from EXPOSE on Vast, no explicit `-p` flag needed. Without EXPOSE 8888, Vast never maps the port → `hls_port` stays null → dashboard video player never renders.

### web/
- `lib/gpu-broker.ts` — **v2:** `rankedCandidates()` (exported), `startProvisionRace()` (N-parallel fan-out, push-readiness), and v1 `provisionGpu()` (Phase 0 improved: 2×3s RTMP probe, fast-fail on terminal states, `onAddrKnown` early-save).
- `lib/datacenters.ts` — broker knobs (`PRICE_CEILING`, `READINESS_TIMEOUT_MS`=110s, `MAX_BOOT_ATTEMPTS`=2, `FALLBACK_LAT/LON`). **Phase 1 lease constants:** `BOX_LEASE_MS`=120s (renewed by every relay→Vercel heartbeat — rides the datacenter link, not the user's home uplink), `RECONNECT_GRACE_MS`=180s (VPS-hub tenant reconnect window, renewed only while OBS source is present), `MAX_SESSION_GRACE_S`=60 (backstop past 12h cap). **Hardening (000010):** `SWEEP_GRACE_MS`=90s (extra settle margin the sweeper waits past lease expiry → effective box-dead ≈ BOX_LEASE+grace ≈ 210s; survives a multi-minute control-plane outage), `PROVISION_LEASE_MS`=300s (boot/first-connect lease stamped at provision INSERT, `/ready`, and attach — covers boot+pair+first-beat and the hub spawn window). Tune here.
- `lib/providers/index.ts` — **Phase 2:** ONE `REGISTRY` (kind+roles); `ACTIVE_*` arrays DERIVED; `resolveProvider(kind,name)` + strict `getProvider`/`getVpsProvider` (throw on blank/unknown — no Vast fallback). `lib/managed-identity.ts` — `MANAGED_BY` + `podName`/`hubName` builders + `ownerOfPodName`/`ownerOfHubName` parsers (the single identity source for the orphan reconcile; the GPU `listInstances` filter is `ownerOfPodName != null` = hub-exclusive). `lib/providers/vast.ts` — offer search, all-in pricing, UDP `-p` flags at create, `SLIMCAST_PROVIDER` inject. `lib/providers/hetzner.ts` — labels the primary IP at create + `releaseAux()` (orphaned-IP sweep). `app/api/account/delete/route.ts` — account deletion (balance-forfeit guard + idempotent Stripe cancel + `teardownAllForUser` + `auth.admin.deleteUser` cascade).
- `lib/billing.ts` — two-tier burn math (`billingLineItems` = sole source for `computeBurnRate` + `buildPricingBreakdown`), `spendableTokens` (allotment+purchased), `deductTokens`/`grantSubscriptionAllotment`/`creditPaymentOnce` RPC wrappers, plan-aware passthrough rates, allotment env (`SUB_ALLOTMENT_TOKENS`/`_CAP`). `lib/billing-clock.ts` — `billStreamInterval()` shared by the pod + hub Clock A heartbeats. `lib/stripe.ts` — `SUBSCRIPTION_PRICE_ID`/`TOKEN_PRICE_ID`. `app/api/subscription/{route,checkout}.ts` — sub status/cancel/portal + recurring checkout. `app/api/webhooks/stripe/route.ts` — `customer.subscription.*` + `invoice.paid`→allotment grant. `scripts/setup-stripe.mjs` — creates the recurring price. `scripts/test-billing.ts` — `npx tsx` billing-math unit tests (22). `lib/nvenc-utils.ts` — `requiredNvencSessions()`.
- `lib/providers/vast.ts` `create()` injects per-pod cost env (`SLIMCAST_GPU_RATE_USD`/`_EGRESS_USD_PER_TB`/`_INGRESS_USD_PER_TB`) from the offer; `app/api/gpu/provision/route.ts` injects `SLIMCAST_COST_CEILING_USD` (1.5 if `has_2k_addon` else 1.0) + `SOURCE_WIDTH/HEIGHT`. Budget telemetry persists to `gpu_instances` (`cost_usd_hr`, `egress_gb_hr`, `ingress_gb_hr`, `suggested_ingest_kbps`, `throttle_tier`); `/api/gpu/status` surfaces them to the dock.
- `lib/agent-config.ts` — shared output builder for config+pair routes.
- `lib/pod-teardown.ts` — `teardownInstance()`, the only destroy path. **v2:** also destroys all pods in `racers` jsonb (losers/booting racers from the parallel race). **Phase 1:** `sweepExpiredLeases()` — universal provider-blind sweeper over all 3 billable kinds (gpu_instances, vps_hubs, relay_nodes/gpu_backend); fired heartbeat-driven from every role (pod/hub/gpu); daily cron demoted to floor. Replaced `sweepStalePods`. `teardownHub` now uses `claim_hub_for_teardown` RPC (derived drain barrier); `teardownInstance` no longer calls `detach_from_hub` (derived occupancy handles it). **Phase 2:** `teardownAllForUser()` — the account-deletion pre-hook (destroys every box a user owns + revokes all keys BEFORE the CASCADE drops the rows); all `provider.destroy` dispatch is now via the strict `getProvider` (no `'vast'` literal in the destroy path).
- `app/api/agent/*` — pair, config, status (billing clock + self-destruct), control, terminate. **v2 new:** `ready` (pod self-reports healthy; CAS winner-selection), `failed` (pod self-reports GPU failure; kicks next race round).
- `app/api/gpu/*` — provision, stop, destroy. All accept `authenticateUserOrAgent`. **v2:** provision route returns 200 in ~5s and starts N=2 racers in parallel (vs old synchronous cascade).
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
| Twitch | RTMP / eRTMP† | 8000 | Landscape | landscape tee group **or** HEVC passthrough† |
| Kick | RTMPS | 8000 | Landscape | landscape tee group |
| YouTube | HLS (fMP4) | source | Landscape* | HEVC passthrough |
| TikTok | RTMP | 4500 | Portrait | portrait tee group (9:16 crop) |

\* YouTube/TikTok can be set to portrait in settings. Facebook dropped (4000 cap dragged shared encode down).

† **Twitch HEVC eRTMP passthrough is gated on account eligibility, detected, not assumed.** Twitch only authorizes HEVC for the 2K tier (Partner/select-Affiliate); 1080p and non-eligible accounts get H.264. `lib/twitch-eligibility.ts` calls `GetClientConfiguration` (with a spoofed RTX 4090 — GPU is unverifiable client data) and reads `encoder_configurations[0].type`: `hevc` → eligible, `h264` → not (Twitch also downgrades a 1440p request to 1080p H.264 for non-eligible accounts — confirms it's account- not resolution-gated; both unlock together, server-authoritative, bound to the stream key, unspoofable). Eligibility is probed on Twitch key save / OAuth connect / manual re-check and stored on `platform_connections` (`twitch_hevc_eligible`, `twitch_use_passthrough`, `twitch_max_height`, `twitch_eligibility_checked_at`). `agent-config.ts` routes Twitch to `mode:'ertmp'` ONLY when `twitch_hevc_eligible && twitch_use_passthrough`; otherwise it falls through to the H.264 landscape tee group. Dashboard surfaces the passthrough toggle + 2K only when eligible. The full eRTMP relay stack (GPU spoof, BPM SEI `relay/bpm_inject.py`, `-rtmp_enhanced_codecs hvc1`) is correct and lights up automatically for any eligible channel — see `memory/ertmp_cpu_passthrough_plan.md`.

## Supabase schema
Tables: `profiles`, `agent_api_keys`, `platform_connections`, `gpu_instances`, `stream_sessions`, `achievements`, `agent_commands`, `credited_payments`, `rate_limits`, `connection_metrics`, `device_link_codes`, `relay_nodes`.

Key columns:
- `profiles`: `streaming_credits` (numeric tokens, default 2.000 — the canonical purchased balance; `streaming_credits_seconds` was a migration-history artifact that never existed on live, dropped/reconciled in `…000007`), `plan` (`payg`/`subscription`), `subscription_status`/`subscription_current_period_end`/`subscription_price_id`, `allotment_tokens` (rolling sub allotment) + `allotment_refreshed_at`, `portrait_zoom/pos_x/pos_y`, `landscape_bitrate_kbps` (6000), `portrait_bitrate_kbps` (4000), `has_2k_addon`.
- `credited_invoices` (Phase 3): idempotency ledger for monthly allotment grants (keyed by Stripe invoice id; service-role-only RLS). `stream_sessions.billed_model` records the plan billed.
- `gpu_instances`: `provider` (default `'vast'`), `burn_rate`, `srt_port`, `session_id`, `max_session_at`, `idle_since`, `outputs` (jsonb), `streaming`, `cost_usd_hr`, `egress_gb_hr`, `ingress_gb_hr`, `suggested_ingest_kbps`, `throttle_tier` (budget throttle telemetry). **Broker v2 columns:** `phase` (text — `requested|racing|ready|streaming|ended`; maps to `status` for backward compat), `racers` (jsonb — array of `{provider, provider_id, state, machine_id?}` for all in-flight racer pods), `race_round` (int — guards next-round kick against duplicate /failed POSTs), `provision_lat/lon` (numeric — stored at provision so /api/agent/failed can rank next-round candidates). **Universal lease (Phase 1):** `renew_deadline` (timestamptz) — renewed by heartbeat every ~120s for legacy pods; renewed only while OBS source is present (~180s) for VPS-hub tenants. Past now() → swept by `sweepExpiredLeases`.
- `agent_api_keys`: service-role only (hashes never reach browser). Labels: `user`/`pod`/`device`/`vps`/`gpu`.
- `relay_nodes` (VPS-as-the-Hub — inert until `SLIMCAST_VPS_HUB`): child of `gpu_instances` (CASCADE) so one session can own a VPS hub **and** a GPU backend (sidesteps `gpu_instances UNIQUE(user_id)`). `role` (`vps_hub`/`gpu_backend`), `provider`, ports (`srt_in_port`/`rtmp_beacon_port`/`bridge_in_port`/`bridge_return_port`/`hls_port`), `racers` jsonb, cost telemetry; `UNIQUE(instance_id, role)`, owner-read RLS. `renew_deadline` (Phase 1 universal lease) — GPU-backend box lease. `gpu_instances` gained `topology`/`needs_transcode`/`vps_node_id`/`gpu_node_id`/`bridge_secret`; `connection_metrics.direction` adds `bridge`. **Bridge telemetry (Phase 4):** the single-tenant GPU backend's whole net throughput IS the VPS↔GPU bridge leg — it measures it (`CostMeter`) and reports `bridge:{ingress_kbps,egress_kbps,active}` in its `/api/agent/status` heartbeat; `handleGpuStatus` attributes it (relay_nodes → instance/user) and writes a `direction='bridge'` row; `handleVpsStatus` writes a coarse `direction='inbound'` row per tenant (OBS→hub source-present); the dock surfaces a gated "→ GPU bridge" series (`has_bridge` from `/api/gpu/status`, only for `topology='vps_gpu'`). Hub-mode per-platform `outbound` is deferred (needs richer VPS reporting). GPU co-location is already wired (Phase 2): the backend race anchors on the hub's `lat/lon`, which the EU-only floor pins to EU.

Postgres fns: `credit_payment_once` (idempotent purchased-token credit, canonical `p_tokens numeric` overload), `deduct_tokens` (allotment-first atomic deduction, `FOR UPDATE`), `grant_subscription_allotment` (idempotent monthly grant, rollover-capped), `rate_limit_hit` (fixed-window). **Phase 1 universal-lease RPCs:** `hub_active_tenant_count(uuid)` (DERIVED occupancy from live `renew_deadline` leases — replaces `session_count`), `reconcile_hub_emptiness(uuid)` (sets/clears `empty_since` from derived count; called by heartbeat Clock B + sweeper), `claim_hub_for_teardown(uuid, onlyIfEmpty bool, requireLeaseExpired bool default false)` (FOR-UPDATE race-safe drain barrier — returns hub row or nothing; replaces `.eq('session_count',0)`; the 3rd arg, added in 000010, makes the box-lease hard-destroy re-check `renew_deadline` under the lock so a recovered hub is spared — TOCTOU fix), `attach_session_to_hub` (rewritten: derived capacity + starts a 300s boot/first-connect lease — was 180s pre-000010), `detach_from_hub` (no-op — occupancy is derived, never decremented). The 000010 lease RPCs (`claim_hub_for_teardown`, `hub_active_tenant_count`, `reconcile_hub_emptiness`) are `service_role`-only.
Latest migration: `20260628000011_provider_backfill.sql` (Phase 2 provider universality — backfills blank `provider` so the new STRICT `getProvider` never trips on legacy data: `gpu_instances`→`vast`, `relay_nodes`→its own `racers[0].provider`, `vps_hubs`→`hetzner`; additive + idempotent + convergent, tested on throwaway PG). **Apply this BEFORE deploying the strict-resolver code** (it's safe against the old code; the reverse order leaks a legacy blank-provider box to the daily reaper for up to 24h). Prior: `20260628000010_lease_hardening.sql` (Phase 1 hardening — `attach` 300s boot lease, `claim_hub_for_teardown` gains `requireLeaseExpired` 3rd arg for the TOCTOU box-lease re-check, lease RPCs tightened to `service_role`; additive + idempotent + convergent, tested 15/15 on throwaway PG). Prior: `20260628000009_universal_lease.sql` (Phase 1 termination system — `renew_deadline` on all 3 billable tables, DERIVED hub emptiness via live-lease count, `session_count` DROPPED from `vps_hubs`, 5 new/rewritten RPCs; closes the orphaned-Hetzner-hub incident class). Prior: `20260628000008_two_tier_billing.sql` (Phase 3 — `profiles` plan/subscription/allotment cols, `credited_invoices`, `stream_sessions.billed_model`, `deduct_tokens` + `grant_subscription_allotment` RPCs; additive, inert until `SLIMCAST_BILLING_ACTIVE`). Prior: `20260628000007_credits_drift_reconcile.sql` (idempotent/convergent reconcile of the §2.3 credit drift — canonical `streaming_credits numeric`, drop dead `credit_payment_once(p_seconds)` overload, fix `handle_new_user`). Migration chain runs through `…000006_gpu_bridge_index.sql` (VPS-hub Phase 2).

## OBS plugin account linking
- **Connect button (preferred):** PKCE OAuth — plugin opens browser to `/link`, user clicks Authorize → one-time code → plugin redeems at `POST /api/link/token` → per-device key issued. No key ever displayed.
- **Manual paste (fallback):** dashboard 'user' key pasted into dock.

## Codec roadmap
- AV1 output later (Ada only — RTX 40/L4/L40, not Ampere).
- Audio: AAC 160k in transcode groups; copied in YouTube passthrough.

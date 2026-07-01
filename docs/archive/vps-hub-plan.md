> **📦 ARCHIVED — SHIPPED.** VPS-as-the-hub architecture; Phases 1–2 are built and the hub is the only user→GPU path. Kept as the design record — the live source of truth is `CLAUDE.md`. Moved here 2026-06-30.

# VPS-as-the-Hub — Implementation Plan

> Status: PLAN (not yet implemented). Produced 2026-06-28 from a full-codebase recon
> (7 parallel subsystem agents) → synthesis → adversarial critique. The critique's
> corrections are folded into this document. Read alongside `CLAUDE.md`.

## 1. Goal & end-state architecture

Introduce a cheap, bundled-bandwidth **VPS (Hetzner first, provider-extensible)** as the
SRT-ingest + platform-delivery **hub**, so that:

- **Passthrough streams** (YouTube always; Twitch only when `twitch_hevc_eligible`) run on
  the VPS alone — **no GPU rented**.
- **Transcode streams** (non-eligible Twitch, Kick, TikTok) terminate SRT on the VPS, bridge
  to a **GPU backend** for NVENC, and deliver to platforms **from the VPS uplink**.

**Data-plane roles** (one relay image, `RELAY_ROLE` env, default `all-in-one` = today):
- `vps_hub` (provider=hetzner, CPU): SRT ingest (long, loss-protected first-mile leg),
  passthrough delivery (YouTube HLS `-c copy`, eligible-Twitch eRTMP+BPM), CPU preview, and —
  for transcode — forwards source to the GPU and fans the GPU's return out to platforms.
- `gpu_backend` (provider=vast): receives source, NVDEC→NVENC transcodes once per orientation,
  returns one stream per orientation to the VPS. Never faces a platform.

**Legs:** OBS→VPS = SRT/UDP (unchanged, robust). VPS↔GPU = bridge (**SRT for the source leg**,
RTMP for the H.264 return leg — see §2.1). VPS→platform = Hetzner bundled bandwidth.

**Control plane (Vercel, unchanged shape):** broker provisions the VPS always + a GPU
conditionally, anchoring GPU selection on the **VPS** region. Nodes self-report via
`POST /api/agent/ready` with a `role`; the OBS-facing `srt_url` from `gpu/status` resolves to
the VPS — **so the shipped OBS plugin keeps working with zero re-release.** Legacy Vast-direct
path stays intact behind `SLIMCAST_VPS_HUB=false`.

---

## 1a. DECISIONS LOCKED (2026-06-28 discussion)

- **VPS lifecycle = long-lived, MULTI-TENANT, autoscaling pool with scale-to-zero.** Per region,
  the first stream spins a hub (~30–90s once); subsequent streams **join instantly** until the box
  hits capacity, then a new hub spins; an idle hub is destroyed (**no users → no VPS**). Per-stream
  STOP tears down that stream's paths + its GPU, **NOT the VPS** (the VPS persists for other
  tenants; only the autoscaler destroys idle hubs). This is what makes the flat-fee economics work
  (amortize one cheap box across many users). Per-stream-destroy VPS is rejected (no amortization +
  Hetzner hourly-rounding waste).
  - **Capacity** ≈ bandwidth-bound ONCE the preview is off: ~10–30 concurrent passthrough streams
    per box (20TB bundle ≈ 61 Mbps sustained; remux CPU is ~free).
- **CPU dashboard preview = PINNED (disabled) for the VPS/passthrough tier.** The preview is the
  720p libx264 transcode that feeds the dashboard's live video player (browsers can't play HEVC
  HLS). It is the single biggest per-stream CPU cost on a CPU box and is what makes the VPS
  CPU-bound; disabling it ~doubles+ density (box becomes purely bandwidth-bound). Cost: the
  dashboard video thumbnail goes dark for passthrough users (stream still verifiable on the
  platforms; dock health graphs/status still work — those are metrics, not video).
  LATER options: (a) for TRANSCODE streams the GPU is already present → it can produce a cheap
  NVENC preview the VPS relays (~zero VPS cost), so transcode users keep the preview; (b) monetize
  preview as an add-on; (c) a lighter snapshot method. Phase 1 ships with preview OFF.
- **Geo is COARSE by design.** SRT (5000ms buffer) preserves quality even cross-planet (worst-case
  ~250–350ms RTT needs only ~1–1.4s of buffer — huge headroom). So a handful of REGIONAL hubs
  (US-East, US-West, EU, +APAC) covers the globe; users hit the nearest existing hub. Geo costs
  *latency* (absorbed by platform buffering), not *quality*. No need for a VPS near each user.
- **GPU catalog EXPANDS to all providers** (Vast, RunPod, any) because the GPU now receives the
  stream over a TCP bridge, not OBS's UDP SRT. Bigger catalog → easy to co-locate a GPU with the
  VPS → return leg stays clean (this substantially de-risks §2.2). Broker ranks GPUs across all
  providers by distance to the **VPS** and races/fans out until one connects cleanly.
  - **Backend-mode GPU filters RELAX (transport cage lifts):** drop the UDP `-p` requirement (the
    block that banned RunPod); need only ~2 ports (bridge-in + return-out) not "≥3 direct + UDP";
    egress is tiny + in-region (the GPU returns ONE stream to the VPS, not a platform fan-out — the
    VPS eats platform egress on its bundle), so the ≤$8/TB / ≥300 Mbps cost filters barely bind.
  - **What stays (silicon, not transport):** `compute_cap ≥ 750` (Turing+) for H.264/HEVC NVENC,
    the driver-≥570 NVENC-regression boot self-test gate, and whole-GPU (`gpu_frac ≥ 1.0`) for
    consumer cards. So it's "any NVENC-capable GPU on any provider," not literally any GPU.
- **Bridge source transport = mpegts-over-TCP** (raw ffmpeg TCP listener on the GPU, NOT MediaMTX),
  superseding the SRT-only call in §2.1: MPEG-TS preserves temporal-layered HEVC (same container
  SRT uses; only RTSP/RTMP mangle it) AND lets TCP-only GPU providers receive it. Return leg
  (H.264; AV1 later) = RTMP/eRTMP or mpegts. **Still spike-before-Phase-2** to confirm NVDEC
  decodes mpegts-over-TCP clean.
  - **SCOPE (important): the bridge is the INTERNAL VPS↔GPU leg, and exists ONLY for transcode
    streams.** It does NOT touch (a) OBS→VPS, which is always HEVC-over-SRT, no exceptions, any
    encoder (VT/NVENC/AMF); or (b) passthrough delivery (YouTube HLS, eligible-Twitch eRTMP HEVC,
    future AV1) — passthrough never goes near a GPU or the bridge. It is NOT an efficiency loss vs
    today: today the all-in-one GPU has no bridge; the hub simply adds this internal hop (done as
    `-c copy` remux, no re-encode), and mpegts-over-TCP is the chosen way because it preserves
    temporal HEVC and unlocks the full TCP-capable GPU catalog. AV1 (passthrough OR transcode
    output) is unaffected by this choice.
- **Billing is DEACTIVATED for now** (free streaming during dev; keep idle/max-session/orphan
  self-destruct for rogue-cost safety, drop the credits≤0 path). The credit-path divergence (§2.3)
  + the two-tier/subscription work all fold into ONE future **billing overhaul** — target model:
  **subscription + monthly token allotment + buy-more-tokens**. Do NOT reconcile the old credit
  system now (schema changes in the overhaul anyway); just keep §2.3 noted.
- **User encoder is never a limiter** (§2 clarification): OBS→VPS SRT carries any HEVC (Apple VT /
  NVENC / AMD AMF); the bridge + NVDEC are encoder-agnostic.
- **eligible-Twitch eRTMP passthrough stays PROVISIONAL** until the user becomes a Twitch Affiliate
  and we validate it live (user will signal when).
- **AV1 = DEFERRED, but do NOT corner the code.** Skip building/testing AV1 now (AV1 NVENC needs
  Ada-class GPUs — RTX 40/L4/L40, a silicon requirement the TCP bridge does NOT remove — and Twitch
  AV1 is still TEB-beta-community only). BUT design for it: (a) AV1 passthrough is already free (the
  VPS path is `-c copy`, codec-agnostic — if a platform accepts AV1 over HLS/eRTMP and OBS sends it,
  it just passes through); (b) keep the transcode OUTPUT codec a parameter (`h264|hevc|av1`), keep
  the bridge return + delivery legs codec-agnostic (mpegts + eRTMP `av01` both carry AV1); (c) treat
  "needs AV1" as just an extra GPU-capability filter (Ada) in the broker. Then AV1 later = config +
  a GPU filter, not a refactor. The expanded multi-provider catalog makes Ada GPUs easier to find.

---

## 1b. PHASE 0 — LIVE FINDINGS (2026-06-28, verified via `web/scripts/test-hetzner.mjs`)

A real create→status→destroy→release-IP round-trip on the live Hetzner API (cost: pennies)
settled two open items and surfaced one bug. **These supersede the matching §2 critique items.**

- **Catalog (supersedes §2.6 "invented server types").** `cpx22`/`cpx32` **DO exist** in the live
  2026 catalog — the critique's claim was stale. Live x86 catalog has two generations:
  - OLD low-bundle lines: `cpx11/21/31/41/51` (1–5 TB incl), `ccx13/23/33/43/53/63` (dedicated, 1–9 TB).
  - NEW **22 TB-bundle** lines (the ones we want — bandwidth-bound hub): `cx23/33/43/53` (Intel shared)
    and `cpx12/22/32/42/52/62` (AMD shared). **Cheapest viable hub = `cx23`** (2c/4g, **$0.0104/hr ≈
    $7.50/mo, 22 TB incl**) or `cx33` (4c/8g, $0.016/hr, 22 TB). The economics are BETTER than planned:
    22 TB bundle ≈ 68 Mbps sustained for ~$7.50/mo. `hetzner.ts` already derives this live (never
    hardcode ids). Still TODO: load-test which tier sustains SRT-terminate+remux+bridge+fan-out (§10.4).
  - **Regions (6) map cleanly onto the coarse-hub plan:** `fsn1`/`nbg1` (DE) + `hel1` (FI) = **EU**,
    `ash` (Ashburn VA) = **US-East**, `hil` (Hillsboro OR) = **US-West**, `sin` (Singapore) = **APAC**.
    Real lat/lon come from `GET /v1/locations`. So US-E/US-W/EU/APAC hubs are all directly available.
- **Primary-IP teardown (refines §2.5/§2.8).** The auto-created primary IP defaults to
  `auto_delete=true` and **Hetzner DOES release it — but ASYNCHRONOUSLY**, ~10–15 s after the server
  finishes tearing down (confirmed: 404 by +15s). There is **no synchronous window to delete it
  ourselves** — an *assigned* primary IP returns **422**. So the rule (now in `hetzner.ts destroy()`):
  delete the server, then touch the IP ONLY if it's already **unassigned** (a true orphan, i.e.
  `auto_delete` was somehow false); never attempt to delete an assigned IP. The leak risk is real only
  for the `auto_delete=false` edge → **the reaper must backstop by sweeping unassigned managed primary
  IPs** (project currently holds 0 after teardown). My first `destroy()` got this wrong (eager delete →
  422 false-"RELEASE FAILED"); fixed + re-verified green.
- **Confirmed working:** live catalog fetch, `create` (returns server id + `public_net.ipv4.{id,ip}`),
  `getStatus`, `destroy`, and confirmed-gone primary IP. `hetzner.ts` shapes are trusted against live.

---

## 2. HARD CORRECTIONS FROM REVIEW — read before anything else

These are the review findings that change the plan or are landmines. Do not start without
internalizing them.

### 2.1 Bridge source transport = **SRT only** (not eRTMP, not "mpegts-over-TCP")
The VPS→GPU **source** leg carries Apple-VT **temporal-layered HEVC** — the exact stream
`CLAUDE.md` arch #2 says RTSP/FLV mangle ("Illegal temporal ID"). And **MediaMTX cannot ingest
raw mpegts-over-TCP** (it does SRT/RTMP/RTSP/WebRTC/HLS only). → The only viable in-stack source
transport is **SRT** (also gives AES via `bridge_secret`). The **return** leg is plain H.264, so
RTMP/eRTMP is fine there. Schema field names `ertmp_in_port` are misleading — rename to
`bridge_in_port`. **Spike this before committing Phase 2.**

### 2.2 The core benefit is partially overstated — co-location is load-bearing
"The GPU's variable uplink never faces a platform" is only half true: the **GPU→VPS return leg
IS the GPU's uplink**, and it's loss-intolerant TCP. If VPS↔GPU isn't genuinely in-region/clean,
a stalling return leg back-pressures the VPS deliver-tee and **viewers still freeze** — the
variable leg is *relocated one hop, not eliminated*. The benefit holds **only if Vast can place
a GPU in-region with the Hetzner VPS**, which is best-effort with limited region overlap. →
**Required: a "no in-region GPU candidate" fallback** (e.g. fall back to all-in-one Vast-direct
for that stream). Without it, the headline win is conditional.

### 2.3 Billing money-path is already diverged — fix it FIRST, in isolation
Verified: repo migration declares `credit_payment_once(p_payment_id, p_user_id, p_seconds int)`
updating `streaming_credits_seconds`, but `lib/billing.ts` calls `.rpc('credit_payment_once',
{p_tokens})` and all code reads `profiles.streaming_credits` (numeric). **The migrations are not
the source of truth for the billing core** — prod is running a hand-diverged function/column, or
the credit path is silently failing. A `supabase db push` of a reconcile migration could clobber
the live function. → **Isolated pre-req:** `supabase db dump` the live function+columns, reconcile
to one canonical form, deploy + verify ALONE, before any VPS or subscription work.

### 2.4 The billing clock must move in **Phase 1**, not Phase 3
Today only `label==='pod'` heartbeats deduct credits + enforce self-destruct. A Phase-1
passthrough VPS has label `vps` → it would **bill nothing** (revenue loss) **and never
self-destruct at credits=0** (rogue-cost risk). → Phase 1 must move the deduction/self-destruct
onto the VPS heartbeat (`authenticateNode` + role check), even before the subscription tier.

### 2.5 Hetzner hourly-rounded billing breaks "no idle billing" + the flat-fee economics  [IP behavior confirmed — see §1b]
Hetzner bills **per hour, rounded up**, and the **primary IPv4 is a separate ~€0.50/mo resource
that survives server deletion**. Per-stream destroy means every OBS start/stop/reconnect = a full
billed hour; a user who restarts 5×/hr pays 5 VPS-hours. **And** the flat-fee thesis ("a cheap box
amortized across users") assumes **multi-tenancy**, but `gpu_instances UNIQUE(user_id)` +
atomic-claim = **one VPS per stream = single-tenant**. → The **VPS lifecycle decision
(per-stream vs warm-pool/long-lived multi-tenant) cannot stay open** — it determines whether the
economics work at all. Likely answer: **long-lived, multi-tenant VPS hubs per region** for the
subscription tier (this is the real unlock), per-stream only as a fallback.

### 2.6 Hetzner server types in the recon are partly invented  [OUTDATED — see §1b]
~~`cpx22`/`cpx32` **do not exist**.~~ FALSE as of 2026 — they exist; see §1b for the real live
catalog (cheapest viable hub = `cx23`, 22 TB bundle, $0.0104/hr). `hetzner.ts` derives the catalog
from live `GET /v1/server_types`. Still TODO: load-test which tier handles
SRT-terminate + remux + bridge + CPU preview (§10.4).

### 2.7 eRTMP-Twitch-as-free-passthrough is **unproven** — don't bet margin on it yet
`needsTranscode()` excludes `ertmp` (rent no GPU for eligible-Twitch-only), but eligible-Twitch
HEVC passthrough has **never been confirmed live** (we only just shipped eligibility detection;
the eRTMP path itself dropped at ~2.26s in testing and prod stays SRT-in). → Treat the
eligible-Twitch cost win as **provisional** until proven on a real eligible account.

### 2.8 Other confirmed gaps to fold in
- **Firewall return-port can't be IP-locked at VPS-create** (GPU IP unknown until it wins the
  race) → either a post-pairing firewall update, or SRT-AES on the return leg. Otherwise the
  return port is open cleartext to the internet. **Decide the bridge security model.**
- **Per-platform health attribution breaks** across two boxes: a GPU transcode crash shows up on
  the VPS only as "no return stream" — the dock's per-platform dots will be ambiguous for
  transcode platforms. Needs a cross-node health story.
- **`confirm-session` (12h cap), `/api/encode`, `/api/platforms`** (the OBS-source-bitrate
  throttle lever round-trips through the plugin) are not in the file map but must keep working.
- **Reaper cadence** (daily) is too slow to backstop Hetzner hourly billing — needs a tighter
  cron for leaked VPS+IP pairs.
- **Key exposure**: keys now decrypt on the VPS (a second untrusted rented box). "Keys never
  reach the GPU" is a reframing, not a net reduction.

---

## 3. Data model

Use a **`relay_nodes` child table** (not widening `gpu_instances` — it has `UNIQUE(user_id)` and
physically can't hold two boxes). `gpu_instances` stays the per-user **session anchor**.

`relay_nodes`: `id`, `instance_id`→gpu_instances (CASCADE), `user_id`, `role`
(`vps_hub|gpu_backend`), `provider`, `provider_id`, `node_key_hash`, `ip_address`, `lat`/`lon`,
`srt_in_port`, `rtmp_beacon_port`, `bridge_in_port` (GPU source ingest), `bridge_return_port`
(VPS return ingest), `hls_port`, `status`, `phase`, `racers` jsonb, `race_round`, `machine_id`,
cost telemetry, `last_seen_at`, `created_at`. `UNIQUE(instance_id, role)`; owner-read RLS.

`gpu_instances` ALTER: `topology` (`passthrough_only|vps_gpu`), `needs_transcode` bool,
`vps_node_id`, `gpu_node_id`, `bridge_secret`. `provision_lat/lon` keep = user geo; GPU race
anchors on the VPS node's lat/lon.

`agent_api_keys`: label CHECK += `vps`,`gpu` (additive; never rename `pod` — orphans in-flight
pods). Optional `node_role`/`instance_id` for direct resolution.

Billing (Phase 3): `profiles.plan` (`payg|subscription`), `subscription_status`,
`subscription_current_period_end`, `subscription_price_id`; `stream_sessions.billed_model`.
**Pre-req:** the §2.3 credits reconcile migration ships first, isolated.

`connection_metrics`: allow `bridge` direction.

---

## 4. Provider design

**Separate `VpsProvider` interface** (do NOT generalize `GpuProvider` — keep Vast 100% untouched
so it can't regress). `web/lib/providers/types.ts` adds `VpsProvider`/`VpsCandidate`/`CreatedVps`/
`VpsStatus` (ports are **fixed** on Hetzner — container port == host == public, no remap).
`index.ts` adds `ACTIVE_VPS_PROVIDERS`/`getVpsProvider` and **fixes `getProvider`'s `?? 'vast'`
fallback to be strict** (silently routing a Hetzner id to `Vast.destroy()` is the #1 leak risk).

`HetznerProvider` (`web/lib/providers/hetzner.ts`, `api.hetzner.cloud/v1`, Bearer token,
3600 req/hr): `listRegions` (catalog from live `GET /v1/server_types`, real lat/lon centroids,
`included_traffic`/`price_per_tb`); `create` (`POST /v1/servers` with `user_data` cloud-config
≤32KiB, ssh_keys, firewalls, `public_net`, `labels:{managed-by:slimcast}`); `getStatus`;
`destroy` (`DELETE /v1/servers/{id}` **THEN `DELETE /v1/primary_ips/{id}`** — IP survives server
deletion); `listInstances` (label-filtered). Reusable firewall: UDP `srt_in` from 0.0.0.0/0; TCP
`bridge_return` locked to GPU IP (post-pairing) or SRT-AES. `web/lib/cloud-init.ts` builds the
`#cloud-config` that installs Docker and runs the relay image in the right role.

Vultr later = a second `VpsProvider` appended to `ACTIVE_VPS_PROVIDERS` — **zero broker change**.

---

## 5. Relay role-split

One image, `RELAY_ROLE=vps|gpu|all-in-one`. `agent.py`: per-role `RELAY_SOURCE`; **skip
`_gpu_self_test` on vps** (else it always fails readiness) + light CPU check; `ready/failed`
carry `role`; **BudgetController runs on the VPS only** (it owns ingress + platform egress +
the `suggested_ingest_kbps` lever); GPU is a config-follower.

`supervisor.py` `plan_runners()` role branch:
- `vps`: passthrough + ertmp readers; if any transcode output → one `source_forward` runner +
  `deliver:{landscape,portrait}` tee runners; CPU preview (libx264).
- `gpu`: `gpu_transcode:{landscape,portrait}` only (NVENC, single return, **not** a tee).
- `all-in-one`: unchanged.

New builders: `build_gpu_transcode_cmd` (NVDEC→scale→NVENC→push one H.264 return; quality ladder
preserved), `build_vps_deliver_cmd` (read GPU return → `-c copy` → tee fan-out; `use_fifo`
backpressure decoupling preserved — fan-out moves here), `build_vps_source_forward_cmd` (SRT
loopback HEVC → push to GPU over SRT). Role MediaMTX templates (`mediamtx.vps.yml`,
`mediamtx.gpu.yml`); `hook.sh` filters `$MTX_PATH` so only the true OBS-source publish trips
`obs_connected`.

---

## 6. Broker flow

`provision/route.ts` (behind `SLIMCAST_VPS_HUB`, after atomic claim):
1. Build outputs with **full mode awareness** (SELECT eligibility; mirror `agent-config`
   mode logic — provision today does NOT consult eligibility; fix here).
2. `needsTranscode()` = any enabled output `mode==='transcode'`, **excluding both `passthrough`
   and `ertmp`** (do not reuse `requiredNvencSessions()` — it counts ertmp).
3. Mint `vps` key (+ `gpu` key if transcode); insert `relay_nodes` rows.
4. **Get a VPS hub first — JOIN-OR-SPAWN per §1a multi-tenant model:** `vps-broker.ts`
   `acquireHub(region)` = find a live hub in the nearest region with spare capacity and attach
   this stream's ingest path to it; only if none has capacity, `provisionVps()`
   (`nearestVpsRegion` + serial fallback — Hetzner is fixed-capacity, not a marketplace; no
   N-parallel race) and persist on `onVpsCreated` so it's reapable immediately. The autoscaler
   (not STOP) destroys a hub once it goes idle (scale-to-zero).
5. **If transcode:** `startProvisionRace({lat:vpsLat, lon:vpsLon})` — reuse the N=2 race
   mechanics **verbatim but anchored on the VPS**.
6. Inject role env; VPS return target delivered to the GPU later via `/agent/config`. Return 200.

Combined readiness (`agent/ready`, role-aware): `vps` CASes to ready (makes `srt_url` serveable;
VPS never a CAS loser); `gpu` keeps winner-CAS/loser-destroy on its own fields. Flip
`status=running` only when `vps_ready AND (!needs_gpu OR gpu_ready)`; write the pairing for the
next `/agent/config` poll. **Migrate every CAS `.or()` phase-guard string** (`provisioning_vps`/
`racing_gpu`) across provision+ready+failed **together** or racers never win.

Failure matrix (must be explicit): VPS-ok/GPU-fail → re-race GPU; VPS-fail/GPU-ok → tear down
GPU + fail; both-fail → fail; **GPU dies mid-stream on healthy VPS → re-race + re-pair** (live
case, was missing). `datacenters.ts`: `VPS_PRICE_CEILING`, `VPS_READINESS_TIMEOUT_MS`,
`BRIDGE_READINESS_TIMEOUT_MS`, Hetzner region→lat/lon, `GPU_GEO_ANCHOR='vps'`. Boot latency vs
timeout → **prebuilt Hetzner snapshot** (cloud-init docker-pull may exceed 110s).

Teardown (`pod-teardown.ts`) destroys **both** boxes (independent try/catch) + releases the
primary IP; reaper reconciles `ACTIVE_VPS_PROVIDERS` too + handles the pair lifecycle +
`never_paired` keyed on the VPS for passthrough-only.

---

## 7. Billing — DEACTIVATED NOW, full overhaul later

**Decision (2026-06-28): billing is turned OFF during the VPS-hub build.** Comment out the
per-second deduction; KEEP the rogue-cost safety self-destruct (idle / max-session / orphan);
drop the credits≤0 path while off. Free streaming during development.

**Future billing overhaul (one bundled effort, post-connection):** target model =
**subscription + monthly token allotment + buy-more-tokens.** This overhaul owns ALL of:
- The §2.3 credit-path divergence reconcile (do it HERE, not now — the schema changes anyway).
- The VPS heartbeat as the **canonical billing clock** (present for every stream; GPU = telemetry
  only).
- Subscription tier (passthrough/affiliate flat) vs metered tokens (transcode/GPU), Stripe
  recurring price + webhooks, plan-aware self-destruct gating (don't kill active subscribers),
  `classifyBillingModel`, eRTMP-Twitch as a passthrough billing class, recomputed transcode rate,
  subscriber-adds-transcode fallback rule.

Until the overhaul: `profiles.plan` etc. are unused; no deduction occurs.

---

## 8. Phased rollout

| Phase | Goal | Cheapest test |
|---|---|---|
| **Pre-req** | Isolated credits/`credit_payment_once` reconcile (§2.3), deployed + verified alone | Inspect credit ledger across a real stream |
| **0 — Foundations** | Additive scaffolding, flag off, prod byte-for-byte unchanged: `relay_nodes` migration, `VpsProvider` types, `hetzner.ts` + cloud-init, strict `getProvider`, `RELAY_ROLE` skeleton, `test-hetzner.mjs` | `test-hetzner.mjs` creates+destroys a real server **+ releases the primary IP**; `tsc` |
| **1 — VPS passthrough** | OBS→Hetzner VPS→YouTube live, **no GPU**, behind flag. **Includes the Phase-1 billing-clock move (§2.4).** | Test account, YouTube-only, push from OBS; confirm live + no GPU rented + clean teardown (server+IP) |
| **2 — GPU bridge** | Transcode on Vast, delivered via VPS. **Bridge-transport spike FIRST (§2.1).** | Kick enabled; verify NVENC on GPU, GPU faces only the VPS, both boxes destroyed on Stop |
| **3 — Two-tier billing** | Flat sub (passthrough) vs metered (transcode); VPS = single clock | Stripe test mode: one subscribed passthrough acct + one payg transcode acct |
| **4 — Geo + hardening + Vultr** | VPS↔GPU co-location, bridge telemetry in dock, warm-pool (if chosen), Vultr provider | Provision in US, confirm GPU near VPS; add Vultr region |

**Phase 4 BUILT 2026-06-28** (code-complete; pending the consolidated live debug):
- ✅ **GPU↔VPS co-location** — already wired in Phase 2 (`startGpuBackendRace` anchors the
  backend race on the hub's `lat/lon`; mid-stream re-race reuses it). No new work needed.
- ✅ **Hetzner = EU-only-by-economics** (NEW, user-locked): `hetzner.ts` filters by per-location
  `included_traffic` ≥ `HETZNER_MIN_INCLUDED_TRAFFIC_TB` (default 18) → keeps the 20 TB-bundle
  EU locations, drops the 1 TB US/SG + old low-bundle lines. SRT's 5000ms buffer absorbs the
  transatlantic first-leg RTT (sub-second latency cost, quality-safe). Optional hard pin
  `HETZNER_ALLOWED_REGIONS`. Co-location then resolves GPUs to EU automatically. The
  "coarse regional hubs" idea becomes a **per-provider region policy** (Hetzner=EU; US comes
  via a future provider).
- ✅ **Bridge telemetry in dock** — GPU backend measures the VPS↔GPU leg (`CostMeter`, single-tenant
  box = pure bridge traffic) and reports it in its heartbeat; `handleGpuStatus` writes a
  `direction='bridge'` row; `handleVpsStatus` writes coarse `inbound`; dock shows a gated
  "→ GPU bridge" series (`has_bridge` from `/api/gpu/status`). Hub-mode per-platform `outbound`
  deferred (needs richer VPS reporting). No migration (the `bridge` direction already exists).
- ✅ **Fast boot = pre-baked snapshot** (warm-pool NOT chosen — keeps scale-to-zero economics):
  `scripts/build-hetzner-snapshot.mjs` bakes Docker + the relay image into a snapshot; set
  `HETZNER_SNAPSHOT_ID` → `cloud-init.ts` emits a minimal "just docker run" config (boots in
  seconds). Unset = full apt+pull (prod-unchanged). Rebuild on relay-image change.
- ⏸️ **Vultr DEFERRED** (user, 2026-06-28): leave Hetzner-only until live testing is complete;
  THEN do a comprehensive best-host search for **both** VPS and GPU and add Vultr for both.

Each phase is independently shippable; rollback = `SLIMCAST_VPS_HUB=false` (instant return to
Vast-direct). Migrations are additive (no down-migration needed). The reaper runs in **both**
modes so test-provisioned VPSes are always cleaned up.

---

## 9. File-change map (every touched/new file)

- **Migrations:** `20260628000001_vps_hub_nodes.sql`, `_two_tier_billing.sql`,
  `_credits_drift_reconcile.sql` (ships first, isolated).
- **Providers:** `types.ts`, `index.ts`, `vast.ts` (backend-mode behind flag), **new**
  `hetzner.ts`, `cloud-init.ts`, `vultr.ts` (later), `scripts/test-hetzner.mjs`.
- **Broker:** `gpu-broker.ts`, **new** `vps-broker.ts`, `datacenters.ts`,
  `app/api/gpu/{provision,stop,route}.ts`, `app/api/agent/{ready,failed}.ts`, `pod-teardown.ts`,
  `app/api/cron/reap/route.ts` (+ tighter cron in `vercel.json`).
- **Agent/pair/config/auth:** `agent-auth.ts` (`authenticateNode`), `agent-config.ts` (split into
  `buildVpsConfig` keeps keys / `buildGpuConfig` no keys), `app/api/agent/{pair,config,status,
  terminate,control}.ts`, `nvenc-utils.ts`, **plus** `confirm-session`, `/api/encode`,
  `/api/platforms` re-validated for the two-node lifecycle.
- **OBS-facing:** `app/api/gpu/status/route.ts` (srt_url → VPS — load-bearing, no plugin
  re-release), `app/api/metrics/connection/route.ts`; plugin changes additive only.
- **Relay:** `agent.py`, `supervisor.py`, `budget.py`, `mediamtx.vps.yml`, `mediamtx.gpu.yml`,
  `hook.sh`, `Dockerfile`, `start.sh`.
- **Billing/Stripe:** `billing.ts`, `stripe.ts`, `setup-stripe.mjs`,
  `app/api/webhooks/stripe/route.ts`, **new** `app/api/subscription/{checkout,route}.ts`,
  `pricing/route.ts`, `credits/auto-refill/route.ts`, `output-settings/route.ts`.
- **Dashboard:** `dashboard/settings/page.tsx`, `components/cost-meter.tsx`,
  `components/stream-manager.tsx`.
- **Config/docs:** `.env.example`, `CLAUDE.md`, `relay/README.md`, `memory/`.

---

## 10. Decisions

**LOCKED (2026-06-28 — see §1a):**
- ✅ VPS lifecycle = long-lived multi-tenant autoscaling pool, scale-to-zero, join-or-spawn.
- ✅ Geo = coarse regional hubs (SRT 5000ms absorbs distance — quality safe).
- ✅ GPU catalog = all providers (TCP bridge); broker anchors GPU ranking on the VPS.
- ✅ Bridge source transport = mpegts-over-TCP (raw ffmpeg listener); return leg = RTMP.
  (Supersedes the SRT-only call in §2.1.) **P1 spike CONFIRMED 2026-06-28** (local, real Apple
  VideoToolbox HEVC + a hierarchical `b-pyramid` temporal-layered HEVC both survive the exact
  `build_source_forward_cmd` `-c copy` → mpegts-over-TLS → `_input_args("tls")` decode chain:
  600/600 frames, zero errors; FLV `-c copy` negative control rejected the same stream, exit 183
  — proving the test was sensitive and *why* mpegts beats RTMP). Only NVDEC-specific decode is
  unverified (no local NVIDIA card) — covered for free on the first live GPU. No relay change.
- ✅ Bridge security (decided 2026-06-28) = **encrypt-only** (self-signed TLS, `tls_verify=0`); NO
  firewall IP-lock for now. Rationale: IP-lock doesn't shrink the GPU pool but adds failure modes
  (timing race before bridge connect + must re-update firewall on every mid-stream GPU re-race).
  ⚠️ **RE-ASK THE USER before production** — when the box is long-lived, revisit IP-lock vs AES.
- ✅ Hetzner boot (decided 2026-06-28) = **pre-baked snapshot** (boots in seconds, well under the
  110s readiness window; rebuild snapshot when the relay image changes). Not cloud-init docker-pull.
- ✅ GPU race width = **N=1** (locked in Phase 2 — VPS already serves passthrough, slow GPU boot
  only delays transcode outputs, halves spend).
- ✅ Hetzner account layout (decided 2026-06-28) = **one project, all regions** (single token, one
  3600/hr rate limit shared by broker+reaper; fine at our scale).
- ✅ No-in-region-GPU fallback = all-in-one Vast-direct for that stream (big catalog makes this
  rare).
- ✅ Billing = DEACTIVATED now; reconcile (§2.3) + two-tier + subscription/token model = one
  future overhaul (§7).
- ✅ eligible-Twitch eRTMP = provisional until the user is a Twitch Affiliate.

**Still open (Phase-2 decisions 1,2,3,5 now LOCKED above — 2026-06-28):**
4. Multi-tenant per-box CAPACITY (concurrent streams) — **empirical, not a preference**: load-test
   per Hetzner server type (real ID from live `GET /v1/server_types`) during the end-to-end live
   test; preview optional/on-demand to raise density. Not blocking the build.

**Still open — billing overhaul (later):**
6. Subscription price + monthly token allotment + buy-more pricing + inclusions (bitrate cap,
   concurrent streams, fair-use TB).
7. Metered/token rate now that platform egress moved off the metered Vast leg.

**Verify (data):**
8. ✅ DONE (§1b): live Hetzner prices/server_types post the 2026 re-pricing fetched. Baseline:
   cheapest 22 TB-bundle hub = `cx23` $0.0104/hr; set `VPS_PRICE_CEILING` with headroom (e.g. $0.20/hr
   covers up to `cpx42`/`cx53`). Still open: per-tier CAPACITY load-test (§10.4).

> **📦 ARCHIVED — BUILD COMPLETE.** GPU-bridge + multi-provider catalog. The remaining live GPU-transcode test is tracked in `gputest.md` (Phase 2). Design record only. Moved here 2026-06-30.

# VPS-Hub Phase 2 — GPU Bridge + Multi-Provider Catalog (implementation doc)

> Status: BUILD COMPLETE (2026-06-28) — P2–P9 done, adversarially reviewed (8 defects fixed), tsc +
> py_compile + relay unit tests green. REMAINING before flag-on: set `RUNPOD_API_KEY` in Vercel; the
> P1 bridge spike folds into the consolidated end-to-end live debug. Builds the GPU bridge so TRANSCODE
> streams (Kick, TikTok, non-eligible Twitch) work through the hub. Read with `vps-hub-plan.md` +
> `vps-hub-phase1.md`. Flag `SLIMCAST_VPS_HUB` is OFF until the live debug.

## Hard constraints (from the user)
- **No Vast-only** — broad multi-provider GPU catalog is the point. Bridge is TCP (works any provider).
- **No user ever straight to GPU** — every stream ingests OBS→SRT→VPS; GPU is always a bridged backend.
  On GPU race exhaustion the transcode outputs **DEGRADE/fail** (VPS passthrough keeps serving); the old
  "fall back to all-in-one Vast-direct" is REJECTED.
- **Billing deferred.** **Finish ALL phases before any live testing** (the P1 spike folds into the final
  end-to-end debug, not a separate live test now).

## Locked pipeline (per leg)
`SRT/HEVC (OBS→VPS)` → `mpegts-over-TLS/TCP (VPS→GPU, raw ffmpeg listener)` → `NVDEC→NVENC (reuse build_group_cmd ladder)`
→ `RTMPS/H.264 (GPU→VPS MediaMTX)` → `per-platform tee (RTMPS/RTMP)`. YouTube + eligible-Twitch stay VPS-direct
passthrough (no GPU). **Keys never reach the GPU** (GPU gets key-free orientation specs; decrypted keys live
only on the VPS via hub-config `bridge.return_outputs`).

## Decisions (locked — sound defaults; build these)
- Return-port home: **`HUB_RETURN_PORT = 1936` constant** (no column); publish `1936/tcp` in hub cloud-init.
- Bridge-in TCP port: **`8899/tcp`** (add to relay Dockerfile EXPOSE → Vast maps free; RunPod via ports array).
- Bridge security: **self-signed TLS, `tls_verify=0`** (encryption-in-flight; GPU↔VPS only, no platform keys).
- Return leg: **RTMPS** into VPS MediaMTX; **fallback** = plain RTMP + `bridge_secret` path-auth on the
  trusted in-region leg if ffmpeg rtmps self-signed verification proves intractable (decide at debug).
- GPU race width: **N=1** (VPS already serves passthrough, so a slow GPU boot only delays transcode outputs,
  not the stream → halves spend). skipN math = `(round+1)*1`.
- Mid-stream GPU death: detect via **`relay_nodes.last_seen_at` staleness** (reaper/sweep) while the parent
  session is live → re-race (NOT teardown).
- Multi-provider: **re-add RunPod in Phase 2** (recover from git `070ed53^`); generic TCP-GPU provider = Phase 4.
- `BACKEND_PRICE_CEILING` ≈ **$1.00** (backend egress is tiny/in-region; fits RunPod SECURE ~$0.99). Tune later.
- `SOURCE_WIDTH/HEIGHT` + return URLs ride in **gpu-config** (per-tenant), not env.
- Budget controller **disabled on `role=='gpu'`** (CostMeter reads /proc/net/dev = bridge bytes, not platform egress).

## Sub-steps (checklist; deps in parens)
- [ ] **P1** SPIKE: temporal Apple-VT HEVC over mpegts/TLS-TCP → NVDEC clean (REAL OBS source, not lavfi). **Folded into the final debug** per "no testing now" — but it's THE risk; if it fails, only the bridge transport changes (P7/P8), the rest is transport-agnostic.
- [x] **P2** schema index `relay_nodes_node_key_hash_idx` (migration `20260628000006_gpu_bridge_index.sql`) + `authenticateNode('gpu')` resolves relay_nodes → {nodeId, instanceId} (`lib/agent-auth.ts`). (—)
- [x] **P3** Multi-provider backend catalog: `lib/runpod.ts` (API, bridge port 8899) + `lib/providers/runpod.ts` (provider + inline DC/GPU catalog, backend-only); `ACTIVE_BACKEND_PROVIDERS=[vast,runpod]` (kept separate from Vast-only `ACTIVE_PROVIDERS`); `mode`+`providers`+`maxPricePerHr` threaded through rankedCandidates/startProvisionRace; Vast backend-mode (drop UDP -p, MIN_DIRECT_PORTS 3→2); Dockerfile EXPOSE 8899; `BACKEND_PRICE_CEILING=$1.00`. `RUNPOD_API_KEY` env needed in prod (set before flag-on). tsc green.
- [x] **P4** Provision restructure: `SLIMCAST_VPS_HUB` ALWAYS acquires hub; `needsGpu` → `startGpuBackendRace` (mints 'gpu' key + bridge_secret, inserts relay_nodes gpu_backend, sets gpu_instances topology='vps_gpu'/gpu_node_id/bridge_secret, races ACTIVE_BACKEND_PROVIDERS anchored on HUB lat/lon, N=1, onRacerCreated→relay_nodes.racers). AcquireHubResult now returns hub lat/lon. tsc green.
- [x] **P5** GPU `/ready` winner-CAS (relay_nodes.phase guard, persist ip+bridge_in_port, destroy losers) + `/failed` (mark+destroy+DEGRADE on all-dead) + `/status` (relay_nodes.last_seen_at) — all role-aware (`role==='gpu'` checked FIRST, before authenticateAgent → fixes the auth-bypass landmine). **Re-race-on-boot-failure deferred to P9** (with the mid-stream re-race, shared helper).
- [x] **P6** `buildGpuConfig` (key-free, grouped by orientation; never decrypts) + GET `/api/agent/gpu-config` (returns source.listen_port 8899, return URLs rtmps://hub:1936/return/<key>/<orient>, groups, crop, source_w/h, bridge_secret) + hub-config `bridge` block (JOIN relay_nodes; source_forward + return_outputs with decrypted keys → VPS only, emitted only when gpu node phase='ready'). tsc green. **← WEB CONTROL PLANE FOR THE BRIDGE COMPLETE (P2–P6).**
- [x] **P7** Relay GPU role: `main_gpu()` (keeps self-test, no MediaMTX/OBS-flag, `_gen_self_signed_cert`, gpu-config poll + heartbeat, `tls://0.0.0.0:8899` listener); `_input_args` tls/mpegts branch (+igndts); `build_gpu_transcode_cmd` (ONE decode → N orientation encodes → N flv returns, key-free); `plan_runners(role=='gpu')`; `_post_ready_gpu`; bridge_port from `VAST_TCP_PORT_8899`/`RUNPOD_TCP_PORT_8899`. (P6)
- [x] **P8** Relay VPS transcode branch: `build_source_forward_cmd` (`-c copy -f mpegts`) + `build_deliver_cmd` (`-c copy -f tee`, use_fifo) → `deliver:{landscape,portrait}` runners; `mediamtx.vps.yml` RTMPS :1936 (`rtmpEncryption: optional`, cert/key) + dedicated hook-free `~^return/.*$` path; `main_vps` cert-gen before MediaMTX + threads per-tenant `bridge` into cfg; cloud-init publishes 1936/tcp (P9 agent). (P6,P7)
- [x] **P9** Teardown + reaper: `teardownInstance`/`teardownHub` capture+destroy the gpu_backend box BEFORE the FK CASCADE delete (+revoke key); reaper folds relay_nodes provider_id/racers into knownPodIds, gpu_backend stale sweep, mid-stream + never-paired re-race (`reraceGpuBackend`). (P4,P5)

### Post-build adversarial review (2026-06-28) — 8 defects found + fixed, then re-verified
Two Workflow passes (5-slice review→verify→synthesize, then a 6-fix re-verify). 7 confirmed defects (3 refuted false-alarms dropped) + 1 adjacent issue, all fixed; internal tests added (relay `test_bridge_cmds.py`, 63 checks). The cluster was: **the contract-mandated RunPod backend was entirely non-functional** (relay reports only `VAST_INSTANCE_ID`, empty on RunPod). Fixes:
- **H1/H2** `agent/ready` `handleGpuReady`: promote the sole `booting` racer when the reported provider_id is empty (else the RunPod winner is mis-tagged loser + destroyed); persist `provider` so teardown/reaper don't `getProvider('')`→Vast-leak the box.
- **H3** reaper orphan reconcile sweeps the deduped union of `ACTIVE_PROVIDERS ∪ ACTIVE_BACKEND_PROVIDERS` (RunPod orphans were never listed → billed forever).
- **M1** `reraceGpuBackend` destroys the dead box (via each racer's own provider) BEFORE the reset discards its id.
- **M2** new reaper `(b2)` branch for never-paired-while-live + `reraceGpuBackend` now nulls `last_seen_at` (a failed re-race re-presents as never-paired and is re-caught).
- **M3** `startProvisionRace` sets `needsProfessionalGpu=false` in `mode:'backend'` (GPU does ≤2 encodes; raw per-platform count falsely demanded a pro card → degrade-to-passthrough on a fine consumer GPU).
- **L1** `_register_secrets` now scrubs `bridge.return_outputs[].targets[].key` (decrypted deliver keys were unredacted in runner argv logs).
- **adjacent** `agent/failed` `handleGpuFailed` destroys the failing box via the racer's own provider (was gated on the empty RunPod provider_id).

## Landmines (keep visible)
1. **GPU-key auth bypass** — ready/failed/status branch on `role==='vps'` then fall to authenticateAgent; a 'gpu' key has a user_id → would clobber the VPS tenant's gpu_instances row. MUST check `role==='gpu'` FIRST in all three.
2. **Keys never reach GPU** — buildGpuConfig must never call buildAgentOutputs/decryptSecret.
3. **No direct-to-GPU fallback** — provision today lets needsGpu fall into runV2Race (all-in-one). Restructure so it degrades instead.
4. **teardownInstance leaks the GPU box** — vps_hub_id branch is logical-detach only; FK CASCADE drops the relay_nodes row but never calls provider.destroy. Add explicit gpu_backend destroy + revoke gpu key.
5. **Reaper blind to relay_nodes** — add relay_nodes.provider_id/racers to knownPodIds + a gpu_backend sweep; a live racer not in knownPodIds could be orphan-destroyed.
6. **MediaMTX wildcard fires hook.sh on the GPU return** — use a dedicated return path block with runOnReady UNSET.
7. **`_input_args` returns [] for `tls://`** — add `-f mpegts -fflags +genpts+igndts -analyzeduration 10M -probesize 10M` (igndts load-bearing after the source_forward `-c copy` remux).
8. **`waitForIp` hard-requires srtPort** (gpu-broker.ts) — a bridge GPU has none. Use ONLY the v2 push-readiness path for the GPU backend (pod POSTs /ready); never provisionGpu/waitForIp.
9. **Anchor confusion** — user geo → nearest HUB; HUB geo → nearest GPU. acquireHubOrSpawn must return (or we re-query) the hub lat/lon.
10. **RTMPS self-signed verify** — ffmpeg rtmps push may reject self-signed; fallback plain RTMP + bridge_secret on the in-region leg.
11. No dashboard preview for bridged transcode tenants (GPU has no MediaMTX, VPS has no GPU) — Phase 4 (GPU emits a preview return).

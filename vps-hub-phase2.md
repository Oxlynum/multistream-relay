# VPS-Hub Phase 2 — GPU Bridge + Multi-Provider Catalog (implementation doc)

> Status: IN PROGRESS. From a code-grounded design pass (4 subsystem maps → synthesis). Builds the
> GPU bridge so TRANSCODE streams (Kick, TikTok, non-eligible Twitch) work through the hub. Read with
> `vps-hub-plan.md` + `vps-hub-phase1.md`. Flag `SLIMCAST_VPS_HUB` is OFF during the build.

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
- [ ] **P2** schema index `relay_nodes_node_key_hash_idx` + `authenticateNode('gpu')` resolves relay_nodes → {nodeId, instanceId}. (—)
- [ ] **P3** Multi-provider backend catalog: recover RunPod (`070ed53^`), `ACTIVE_BACKEND_PROVIDERS` registry, thread `mode:'backend'`+`providers` through rankedCandidates/startProvisionRace, Vast backend-mode (drop UDP -p, MIN_DIRECT_PORTS 3→2), Dockerfile EXPOSE 8899, `BACKEND_PRICE_CEILING`. (—)
- [ ] **P4** Provision restructure: `SLIMCAST_VPS_HUB` ALWAYS acquires hub; if needsGpu → mint 'gpu' key + bridge_secret, insert relay_nodes gpu_backend, set gpu_instances topology='vps_gpu'/gpu_node_id/bridge_secret, `startGpuBackendRace` anchored on HUB lat/lon (N=1). (P2,P3)
- [ ] **P5** GPU `/ready` CAS + `/failed` re-race + `/status` heartbeat — role-aware (check `role==='gpu'` FIRST), all on relay_nodes. (P2,P4)
- [ ] **P6** `buildGpuConfig` (key-free, grouped by orientation) + GET `/api/agent/gpu-config` + hub-config `bridge` section (decrypted keys → VPS only). (P2,P4)
- [ ] **P7** Relay GPU role: `main_gpu()` (keep self-test, drop MediaMTX/OBS-flag, cert gen, gpu-config poll); `_input_args` tls/mpegts branch; `build_group_cmd(return_url)`; `plan_runners(role=='gpu')`. (P1,P6)
- [ ] **P8** Relay VPS transcode branch: `source_forward` + `deliver:{landscape,portrait}` runners; mediamtx.vps.yml RTMPS :1936 + dedicated return path (NO runOnReady); main_vps threads `bridge`; cloud-init publishes 1936/tcp. (P1,P6,P7)
- [ ] **P9** Teardown + reaper: `teardownInstance`/`teardownHub` destroy the gpu_backend box (FK CASCADE does NOT call provider.destroy → leak); reaper sees relay_nodes (orphan + stale gpu sweep) + the mid-stream re-race trigger. (P4,P5)

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

> **📦 ARCHIVED — SHIPPED 2026-06-29.** Multi-tenant VPS-hub passthrough. Design record only; `CLAUDE.md` is current. Moved here 2026-06-30.

# VPS-Hub Phase 1 — Multi-Tenant Passthrough (implementation doc)

> Status: IN PROGRESS. Produced 2026-06-28 from a code-grounded design pass (4 parallel
> subsystem maps → synthesis). Goal: OBS → Hetzner VPS → YouTube (+ eligible-Twitch eRTMP)
> live, **NO GPU**, behind `SLIMCAST_VPS_HUB` (default off). Prod all-in-one path stays
> byte-for-byte unchanged. **MULTI-TENANT**: one VPS serves many users (join-or-spawn,
> scale-to-zero). Billing DEACTIVATED (only self-destruct safety kept). Read with `vps-hub-plan.md`.

## ⚠️ PRELAUNCH REMOVAL (temporary dev code — DELETE before production)
- **Private-dev access gate** in `web/app/api/gpu/provision/route.ts` (marked `TEMPORARY PRIVATE-DEV GATE`):
  blocks all streaming except emails in `SLIMCAST_ALLOWED_EMAILS`. Currently set to `oxlynum@gmail.com`
  in Vercel prod. Before launch: delete the gate block AND unset/clear `SLIMCAST_ALLOWED_EMAILS`.
- **Billing deactivated** globally via `SLIMCAST_BILLING_ACTIVE` (default off). Before launch: the billing
  overhaul re-enables it (see vps-hub-plan.md §7).

## Known Phase-1 limitations (deferred, documented)
- **Mid-session transcode add on a hub tenant is silently dropped** (review #12). If a tenant who
  provisioned passthrough-only later enables a transcode platform (Kick/TikTok) or flips YouTube/Twitch
  to portrait, `hub-config` (buildVpsConfig filters to passthrough/ertmp) drops that output — the hub has
  no GPU to encode it, and there's no error surfaced. Can't occur in the YouTube-only live test, and the
  flag gates everyone else. **Proper fix = Phase 2** (the GPU bridge brings a "tenant gained a transcode
  output → migrate to a GPU pod" path). Until then, treat hub tenants as passthrough-fixed for their session.

## Adversarial review (2026-06-28) — FIXED
A find→verify review pass confirmed 19 issues (9 high). Fixed before the relay/live test:
non-atomic detach double-decrement (delete-is-the-gate), `sweepStalePods` missing the hub guard,
`empty_since` not set at spawn, scale-to-zero TOCTOU (teardownHub drain-barrier CAS + `onlyIfEmpty`),
stuck-'spawning' region poisoning (attach age guard + inline reclaim) + dead-but-live attach (attach
liveness guard), `PROVISION_LOCK` < boot window (hub-aware reclaim guard), `/status` self-heal promotion,
orphan-reconcile spawn-window guard, `vps_hub_id` client-write lockdown, `/api/gpu/stop` hub-aware.
Migration `20260628000005`. #12 deferred (above).

## Resolved decisions (Phase 1)
- **Data model:** NEW shared `vps_hubs` table + `gpu_instances.vps_hub_id` FK. `relay_nodes`
  (Phase 0) is per-session → reserved for the Phase-2 GPU backend, NOT used for the shared hub.
- **SRT isolation:** ONE shared hub passphrase + a **MediaMTX wildcard path** routing by the
  unguessable 24-char streamid. No per-join config reload (which could drop other tenants' live
  SRT sessions). Per-path passphrases = later hardening. → relay reconcile only starts/stops the
  per-stream FFmpeg Supervisor; MediaMTX config stays static.
- **Scale-to-zero:** true zero, ~10-min idle grace (Clock B, reaper-driven). A single tenant
  stopping fires Clock A only (logical detach); the box dies only when `session_count==0`.
- **Capacity:** `max_sessions=10` default (load-test §10.4 pending; box is bandwidth-bound).
- **Boot latency:** accept longer first-user spawn; prebuilt snapshot deferred to Phase 4.
- **Reconnect:** retain `vps_hub_id` across brief disconnect (refcount stays exact).
- **Billing:** OFF. Comment out credit deduction / auto-refill / credits-exhausted kill. KEEP
  idle / max-session / orphan self-destruct. Hub-config returns a large `credits_seconds` so the
  relay's credits<=0 self-stop never fires.

## Data model (S1)
NEW `vps_hubs`: `id`, `provider`('hetzner'), `provider_id`(server id), `primary_ip_id` (persist
SYNC after create — leak guard), `ip_address`, `region`, `lat`/`lon`, `server_type`, `status`
(`spawning|live|draining|ended`), `max_sessions`(10), `session_count`(refcount), `hub_key_hash`,
cost telemetry, `last_seen_at`, `created_at`. Index `(region,status)`; **partial unique
`(region) WHERE status='spawning'`** = spawn lock. Service-role only (no user_id, no owner RLS).
`gpu_instances` += `vps_hub_id uuid references vps_hubs(id) on delete set null` (+ index).
RPCs: `attach_to_hub(region)` (FOR UPDATE SKIP LOCKED conditional `session_count<max_sessions`
increment → returns hub row or none); `detach_from_hub(hub_id)` (decrement, floor 0).

## Sub-steps (checklist)
- [x] **S1** Data model: `vps_hubs` + `gpu_instances.vps_hub_id` + attach/detach RPCs + spawn-lock index. (migration 20260628000002, applied+verified)
- [x] **S1b** Hub secrets (`srt_passphrase`, `panel_password`) + attach RPC widened to `status in (live,spawning)` for early joiners. (migration 20260628000003, applied)
- [x] **S2** Mode-aware provision inputs + `needsTranscode` via shared `classifyMode`; `requiredNvencSessions` now skips `ertmp`. `provision/route.ts`, `agent-config.ts`, `nvenc-utils.ts`.
- [x] **S3** `authenticateNode()` (resolves a 'vps' key → hub, never a user_id) + `buildVpsConfig()`. `agent-auth.ts`, `agent-config.ts`.
- [x] **S4** `GET /api/agent/hub-config` (authenticateNode vps; all attached tenants' streams + large `credits_seconds`; touches hub `last_seen_at`).
- [x] **S5** `vps-broker.ts` `acquireHubOrSpawn` (join nearest-first, else spawn w/ lock) + provision flag branch + cloud-init wiring + SYNC IP persist + `datacenters.ts` knobs. Exported `haversineKm`.
- [x] **S6** Role-aware `/ready` (hub→live, promote provisioning tenants) + `/failed` (hub→teardownHub). Pod CAS path unchanged.
- [ ] **S7** Relay vps role: skip `_gpu_self_test` + GPU preview; hub-config poll + reconcile `dict[ingest_key→Supervisor]`; thread per-stream source/width/height; `mediamtx.vps.yml` wildcard path.
- [ ] **S8** `hook.sh` per-path signaling (`/tmp/obs_connected.<path>` only for true publish path) + per-stream flag watch (no box-wide `stop_all`).
- [x] **S9** Billing deactivated (flag `SLIMCAST_BILLING_ACTIVE`, default OFF — gates deduction/auto-refill/credits-kill; idle/max-session safety stays) + status-route hub heartbeat branch (Clock A per-tenant + timely scale-to-zero self-destruct). `status/route.ts`.
- [x] **S10** `teardownInstance` hub-aware: hub-session teardown = logical `detach_from_hub` (NEVER destroys box) + new `teardownHub()` (Clock B physical destroy + IP release). `pod-teardown.ts`.
- [x] **S11** Hub-aware reaper: per-session loop skips hub tenants; Clock B (spawn_timeout/stale_hub/scale_to_zero) + Hetzner orphan reconcile. `empty_since` (migration 20260628000004) drives scale-to-zero grace. Cron stays daily (Hobby cap) — heartbeat path covers timely scale-to-zero; cron is the crashed-hub backstop. Standalone leaked-IP sweep DEFERRED (auto_delete=true + teardownHub IP-release cover it).
- [x] **S7** Relay vps role: `agent.py` `main_vps()` (skips `_gpu_self_test`; renders `mediamtx.vps.yml` wildcard path; `_post_ready_vps`; hub-config poll → reconcile `dict[ingest_key→Supervisor]`; per-tenant connect via `/tmp/obs_connected.<key>`; status role='vps'; NEVER `/api/agent/terminate`). `supervisor.py`: `plan_runners(source, role)` threads per-stream source + skips GPU preview/transcode on `vps`; `Supervisor(source, role)`. `mediamtx.vps.yml` wildcard + shared passphrase.
- [x] **S8** `hook.sh` per-`$MTX_PATH` flag (`/tmp/obs_connected.<key>`) alongside the global flag (all-in-one unchanged).
- [x] **Supervisor prod hardening** (review of supervisor.py, 22 findings): fixed the `stop()`/`Popen` orphan-process race (per-runner lock + post-spawn `_stop` recheck), `_redact` set-snapshot, SRT-passphrase + per-tenant-source-key redaction, `errors='replace'` on stderr. Deferred (documented below): eRTMP-multi-tenant cache/canvas, eRTMP re-resolve, bash-injection hardening, grace-timer race, low-prob lows.
- [ ] **S12** Verify `gpu/status` srt_url resolves to hub (✅ confirmed needs no code change — builds srt_url from session ip/srt_port/ingest_key/passphrase, which broker points at the hub) + end-to-end live test.

> ⚠️ Web control plane (S1–S6,S9–S11) is DONE + shipped (flag off). Before flipping `SLIMCAST_VPS_HUB=true`
> for the live test, the RELAY vps role (S7+S8) MUST land + a review pass. The relay image must rebuild
> (relay/** CI) and `SLIMCAST_RELAY_IMAGE` re-pin before a hub can boot the vps role.

Deps: S3←S1; S4←S1,S3; S5←S1,S2; S6←S1,S3,S5; S7←S4; S8←S7; S9←S1,S3; S10←S1,S5; S11←S1,S5,S10; S12←S5,S6,S7,S9,S10.

## Landmines (from the recon — keep visible)
1. NEVER insert a per-session `role='vps_hub'` `relay_nodes` row (N rows/box, no refcount, CASCADE drops it). Use `vps_hubs`.
2. Do NOT widen `isPodAgent` (`status/route.ts`) to include 'vps' — first tenant's idle would teardown the whole box.
3. `teardownInstance` calls `getProvider(provider).destroy` → `getProvider('hetzner')` THROWS by design. Never write hub `provider_id` onto a `gpu_instances` row; route hub destroys only via `getVpsProvider` from Clock B.
4. Hetzner primary-IP leak: persist `primary_ip_id` SYNC after `create()`; reaper sweeps unassigned managed IPs (auto_delete=false edge).
5. Per-tenant passphrase needs per-path config (handshake precedes HTTP auth) → resolved via shared passphrase + wildcard path (no reload).
6. `hook.sh` writes ONE global flag + agent `stop_all` is box-wide → must key by `$MTX_PATH`, stop only the affected tenant.
7. `RELAY_SOURCE`/`SOURCE_WIDTH/HEIGHT` are globals → must become per-stream (builders already accept `source=`).
8. `_gpu_self_test` runs unconditionally before MediaMTX + plan_runners always appends GPU preview → gate BOTH out on `RELAY_ROLE=='vps'`.
9. Relay self-stops on `credits_seconds<=0` from config poll → hub-config must return large positive credits.
10. Provision today ignores Twitch eligibility (marks only youtube passthrough) → mirror `agent-config` mode logic or eligible-Twitch-only misclassifies as transcode → rents a GPU.
11. `attach_to_hub` must be idempotent: increment only when `vps_hub_id` was NULL (guards rate-limit re-provision + Vercel retries).
12. Spawn race → partial-unique `(region) WHERE status='spawning'`; loser polls-and-attaches.
13. Decrypted keys for MANY tenants live on one rented hub → lock hub-config to authenticateNode(vps); keys in memory only.
14. `gpu/status` downgrades running→provisioning on stale `last_seen_at` → hub heartbeat must keep each tenant's `last_seen_at` fresh or srt_url flaps.
15. CAS `.or()` phase-guards are PostgREST filter literals — keep hub readiness OUT of that fragile per-session CAS (use deterministic single spawn).

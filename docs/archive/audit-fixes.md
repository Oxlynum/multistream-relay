> **📦 ARCHIVED — COMPLETE.** All fixes from the 2026-06-30 soundness audit were committed. Historical worklog. Moved here 2026-06-30.

# Audit fixes — 2026-06-30

Plan of record for fixing the 7 confirmed findings from the soundness audit (20-agent
fleet, each finding adversarially re-verified). Persisted so work survives a context
compaction. Check items off as commits land.

**Baseline (already green):** `tsc` clean · billing 22/22 · provider-universality 16/16 ·
`py_compile` clean · no dead refs · git thrash verified clean (HEAD == pre-thrash 670dec4).

**Caveat:** findings #3/#4/#5/#6 live in the 2026-06-29 hub-bridge refactor, which has
NEVER run on a real GPU. They are logically traced as reachable, not yet runtime-observed.

---

## The 7 fixes

| # | Sev | Bug (one line) | File(s) | Commit |
|---|-----|----------------|---------|--------|
| 4 | high | GPU with no bridge port / lost /ready "assumes winner" + heartbeats → bills 12h doing nothing | `relay/agent.py` (`main_gpu`, `_post_ready_gpu`) | C1 |
| 5 | high | Stuck-`racing` GPU renews its own lease unconditionally → no reaper ever kills it (server half of #4) | `web/app/api/agent/status/route.ts` (`handleGpuStatus`) | C1 |
| 3 | high | Leaked GPU shares `slimcast-<userId8>` name → orphan reaper skips it forever | `web/app/api/cron/reap/route.ts`, `web/lib/managed-identity.ts`, `web/lib/vps-broker.ts`, `web/lib/providers/vast.ts` (+ `runpod.ts`) | C2 |
| 1 | med | 2K gate is height-only → falsely flags entitled 1080×1920 portrait, downscales to 608×1080 | `slimcast-obs/src/relay-dock.cpp` | C3 |
| 2 | low | Hetzner disk-floor fails OPEN on a transient image-lookup error → 422 hub spawns | `web/lib/providers/hetzner.ts` | C4 |
| 6 | med | Twitch eRTMP reports stale global 1080p canvas for a 1440p bitstream | `relay/supervisor.py` (`_resolve_ertmp_url`) | C5 |
| 7 | low | CLAUDE.md fifo doc tells future devs to re-add the option that takes every platform dark | `CLAUDE.md` ~L187 | C6 |

---

## Commits (ordered: money-leaks first, then last-night churn, then polish)

- [x] **C1 — GPU CAS-failure handling (#4 + #5), one bug two halves.** ✅ py_compile + tsc green. Shared `web/lib/gpu-ready.ts` `promoteGpuNodeReady()` extracted; `agent.py` exits on no-port/unconfirmed-CAS + carries bridge addr in heartbeat; `status/route.ts` self-heals a lost /ready.
  - `agent.py main_gpu`: if `bridge_port is None` → `_post_failed('no 8899 mapped')` + `sys.exit(1)`.
  - `agent.py main_gpu`: a `None` from `_post_ready_gpu` (CAS unconfirmed) → `_post_failed` + `sys.exit(1)`, NOT "assume winner". Stop the inherited all-in-one optimism.
  - `agent.py` heartbeat body: include `ip` + `bridge_port`.
  - `status/route.ts handleGpuStatus`: when beat carries ip+bridge_port and node not promoted, run the same idempotent CAS as `handleGpuReady` (`.or('phase.is.null,phase.eq.requested,phase.eq.racing')`) → self-heal a lost /ready; promote `racing→ready`, tear down losers.
  - Gate: `py_compile` + `tsc`.

- [x] **C2 — Reaper blind spot (#3).** ✅ tsc 0 · provider-universality 16/16 · billing 22/22. Session-unique `podName(userId,nodeId)` → `slimcast-<userId8>-<nodeId8>`; `ownerOfPodName` head-parse + new `nodeTokenOfPodName`; reaper guard matches live `relay_nodes(gpu_backend).id` tokens (legacy-name prefix fallback for deploy safety); `vast.ts destroy()` throws on non-ok (404=ok). Done the PROPER way (no live old-named boxes):
  - `managed-identity.ts`: `podName(userId, nodeId)` → `slimcast-<userId8>-<nodeId8>`; keep `ownerOfPodName` parsing the userId8 head; add a node-token parser.
  - `vps-broker.ts`: pass `nodeId` at both call sites (358/381 + rerace 536).
  - `reap/route.ts`: build `knownNodeTokens` from live `relay_nodes(gpu_backend).id`; spare at L131 only when the box's node-id tail is live.
  - `vast.ts destroy()`: check `res.ok`, throw on failure (so silent no-op destroys surface). (Confirm `runpod.ts destroy()` already does.)
  - Fallback if `podName` has other consumers: lighter interim — narrow L131 to spare only owners with a row in a provisioning/racing phase.
  - Gate: `tsc` + provider-universality test.

- [x] **C3 — 2K portrait gate (#1).** ✅ Plugin built (exit 0) + installed to `.plugin` bundle. **USER: restart OBS to load.** All 3 sites short-side aware; `downscaleOutputTo1080` pins the short side (portrait→1080×H, landscape→W×1080).
  - `passes2kGate()` L1325, `updateIngestLabel()` L1018, `downscaleOutputTo1080()` (pin the short side, not always height).
  - Gate: rebuild plugin (`cmake --build --preset macos-arm64`). **User must restart OBS to load.**

- [x] **C4 — Hetzner fail-closed (#2).** ✅ tsc 0. `SNAPSHOT_DISK_GB_FALLBACK` (env `HETZNER_SNAPSHOT_DISK_GB`, default 80) seeds the floor when a snapshot is set; only the live 200 lowers it.

- [x] **C5 — Twitch eRTMP canvas (#6).** ✅ py_compile OK. `_ERTMP_CANVAS={720p,1080p,1440p}`; canvas derived from `out.resolution` (falls back to global); stale comment fixed.

- [x] **C6 — CLAUDE.md fifo doc (#7).** ✅ Rewrote L187 to match the shipping code (queue_size only; never re-add drop_pkts_on_overflow without a live-proven escaping).

**ALL 6 DONE + COMMITTED + PUSHED (2026-06-30).** Final gate green: tsc 0 · billing 22/22 ·
provider-universality 16/16 · relay py_compile OK · OBS plugin builds + installed.
Commits `8dfff08..5078937` pushed to `origin/main`:
- `8dfff08` C1 fix(gpu-leak) · `df27dab` C2 fix(reaper) · `6097c8b` C3 fix(dock)
- `4a2cf54` C4 fix(hetzner) · `87802af` C5 fix(relay eRTMP) · `5078937` C6 docs(fifo)
CI: relay Docker build in_progress → auto-pins SLIMCAST_RELAY_IMAGE + redeploys; Vercel deploys web.
**User action: restart OBS to load the rebuilt plugin (C3).** No DB migration needed.
Optional later: note the new session-unique GPU box name (`slimcast-<userId8>-<nodeId8>`) in
CLAUDE.md — not stale today (only generic mentions), documented in managed-identity.ts.

---

## Final gates (before any push)
`cd web && npx tsc --noEmit && npx tsx scripts/test-billing.ts && npx tsx scripts/test-provider-universality.ts`
`cd relay && python3 -m py_compile agent.py supervisor.py budget.py`

## Push policy
Commit locally + run gates after each group. **PAUSE before `git push`** — pushing `relay/**`
triggers Docker CI + auto-pins Vercel + redeploys, and `web/` deploys on push. The user is
mid-debug; confirm before any deploy-triggering push.

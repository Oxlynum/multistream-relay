# VASTBROKER v2 — Vast-native broker rewrite plan

Written 2026-06-26. Successor to `vastbroker.txt` (the v1 diagnosis). This is the
implementation plan, grounded in a completed, adversarially-verified codebase audit.

---

## 0. One-paragraph status

Streams fail to start since the RunPod→Vast / RTMP→SRT switch. The verified root cause is
**the provisioning broker, not the relay and not any protocol leftover.** The relay's SRT
media path is clean and stays. The broker is RunPod-shaped: it runs a **synchronous serial
cascade of up to 5 candidate pods inside one 300s Vercel request**, and the cloud **probes**
each pod for readiness. On Vast (slow, late-mapping UDP ports, marketplace hosts that fail the
GPU self-test) the cascade overruns 300s, Vercel kills the function mid-flight, `srt_port` is
never saved, and **OBS never receives a URL to publish to.** This plan replaces that one
subsystem with a Vast-native design — pods *push* readiness, candidates *race* in parallel, and
provisioning is an *async state machine* — then layers a warm pool / self-hosted GPU for the
"instant" target. Everything else (relay, `vast.ts`, ranking, teardown, reaper, billing, OBS
plugin, auth) is kept.

---

## 1. The three inversions (design principles)

| # | Today (RunPod-shaped) | v2 (Vast-native) |
|---|---|---|
| **I1** | Cloud **probes** the pod (`waitForIp`/`probeRtmp`/`probeUdp`) to learn readiness | Pod **pushes** readiness: `POST /api/agent/ready` / `/failed`. Bad host known in ~1s, not 60–180s |
| **I2** | **Serial cascade**: rent one, wait, fail, try next | **Parallel race**: rent top N at once, first-ready wins, losers self-destruct |
| **I3** | Whole cascade held in **one 300s request** | **Async state machine** on the row; the provision POST returns in ~5s; the dock's existing status poll observes it advance |

These three are the whole fix. A warm pool (§8) and self-hosted provider (§9) are the "instant"
layer that bolts cleanly on top once I1–I3 exist.

---

## 2. Target flow

```
OBS "Start Streaming"
  │
  ▼
POST /api/gpu/provision  (returns 202 in ~5s — NEVER holds the race)
  • payment gate (unchanged)
  • TRY WARM POOL: atomic claim a pre-booted pod → if hit, status=READY, return  ── §8
  • else COLD RACE:
      atomic claim row (status=REQUESTED, UNIQUE(user_id) lock — unchanged)
      generate per-session secrets (ingest key, SRT passphrase) — unchanged
      rank candidates (tier→distance→price) — unchanged (lib/gpu-broker.ts rankedCandidates)
      fan out N=2–3 provider.create() IN PARALLEL, append each {provider,provider_id} to
        the row's `racers` jsonb (so ALL are reapable immediately)
      status=RACING
      return 202
  │
  ▼  (each racer pod, independently)
agent.py boot:
  read PUBLIC_IPADDR / VAST_UDP_PORT_8890 / VAST_TCP_PORT_1935 from its OWN env
  GPU self-test  ──fail──►  POST /api/agent/failed {machine_id, reason}  → sys.exit(1)
       │ pass
  start MediaMTX
  POST /api/agent/ready { ip, srt_port, rtmp_port, container_label }
  │
  ▼
/api/agent/ready handler:
  CAS on the row: first ready racer for this session WINS
     → write ip_address, srt_port, ingest_key; status=READY; build srt_url
     → mark every other racer a loser
  losers: told to self-destruct (heartbeat "you lost") + reaper backstop
/api/agent/failed handler:
  record machine_id (optional denylist); mark that racer dead
  if ALL racers dead with no winner → kick the NEXT round of N (idempotent, guarded by race_round)
  │
  ▼
OBS plugin polls /api/gpu/status → sees status=READY + srt_url → publishes SRT → heartbeat
  streaming=true → status=STREAMING.  STOP → teardownInstance() (unchanged).
```

Wall-clock collapses from "sum of several slow serial failures" to "the fastest of N hosts to
boot" (~30–60s cold), with no request holding the cascade — so it can never again be killed
mid-flight or lose `srt_port`.

---

## 3. The state machine

One row in `gpu_instances` per user (the UNIQUE(user_id) anti-orphan lock is kept). State lives
in `status`; the in-flight racers live in a `racers` jsonb array so all N are reapable from the
single row (avoids needing N rows, which UNIQUE(user_id) forbids).

```
REQUESTED ──(N creates fan out)──► RACING ──(first /ready CAS wins)──► READY
                                     │                                   │
                                     │ (all racers /failed, round<max)   │ (heartbeat streaming=true)
                                     └──► RACING (next round)            ▼
                                     │ (rounds exhausted)            STREAMING
                                     └──► ERROR                          │
                                                                         │ (stop / idle / credits / max_session)
                                                                         ▼
                                                                       ENDED → teardownInstance()
```

- **Who drives each edge:** `REQUESTED→RACING` = provision route. `RACING→READY` = the pod
  (`/api/agent/ready`). `RACING→RACING(next round)` / `RACING→ERROR` = `/api/agent/failed`
  handler. `READY→STREAMING` = heartbeat. `*→ENDED` = stop/heartbeat/reaper.
- Mapping for backward-compat: existing `'provisioning'` covers REQUESTED+RACING, `'running'`
  covers READY+STREAMING — so the OBS plugin and reaper keep working unchanged if we map the new
  fine-grained states onto the old `status` CHECK plus a new `phase` column (see §4).

---

## 4. Schema migration

New migration under `web/supabase/migrations/` (next in sequence after
`20260626000003_budget_throttle.sql`). Additive only — never breaks the live broker:

- **`racers jsonb default '[]'`** on `gpu_instances` — array of `{provider, provider_id,
  state:'booting'|'ready'|'failed'|'loser', machine_id?}`. Appended at create; the reaper scans
  it so every racer is reclaimable. The winner's `provider_id` is promoted to the top-level
  column (teardown/reaper already read that).
- **`phase text`** (nullable) — fine-grained state: `requested|racing|ready|streaming|ended`.
  Keep the existing `status` CHECK working by mapping phase→status (racing→`provisioning`,
  ready/streaming→`running`). v1 broker ignores `phase`; v2 reads it. Lets us A/B without a
  destructive CHECK change. (Alternative: widen the `status` CHECK to add the new values — more
  invasive to every existing query; not recommended for the flagged-coexistence period.)
- **`race_round int default 0`** — guards the "kick next round" path against duplicate
  `/failed` POSTs (CAS increments it; only the transition that wins the increment fans out).
- **Warm pool:** `is_warm boolean default false`, `claimed_at timestamptz`. Warm pods are rows
  with `user_id IS NULL` (Postgres UNIQUE allows multiple NULLs, so the pool can hold K of them
  without touching the per-user lock). Claim = atomic `UPDATE … SET user_id=…, is_warm=false …
  WHERE id = (SELECT id … WHERE is_warm AND user_id IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED)`.

> Next.js 16: read `web/node_modules/next/dist/docs/` before touching route/server-action code.
> Apply with `supabase db push` per the repo convention.

---

## 5. New API surface

Two new pod-authenticated endpoints (auth via `authenticateUserOrAgent`, `lib/agent-auth.ts`):

**`POST /api/agent/ready`** — the pod self-reports it is healthy and serving.
```
req  { ip, srt_port, rtmp_port, container_label }   // all from the pod's Vast-injected env
       (NOT the ipify egress IP — PUBLIC_IPADDR is the real ingest IP)
behavior:
  find the claim row by the pod's key hash (label='pod')
  CAS: if phase='racing' AND no winner yet:
     set ip_address, srt_port, ingest_port(=rtmp_port), phase='ready', status='running',
         build srt_url; mark this racer 'ready', others 'loser'
     → 200 {winner:true}
  else (someone already won): → 200 {winner:false, action:'self_destruct'}
resp { winner: bool, action?: 'self_destruct' }
```

**`POST /api/agent/failed`** — the pod self-reports it cannot serve (GPU self-test failed).
```
req  { machine_id, reason }
behavior:
  mark this racer 'failed' in `racers`
  optionally append machine_id to VAST_MACHINE_DENYLIST telemetry
  MUST NOT call teardownInstance / delete the claim row (preserves the row-ownership invariant
     the broker depends on — see relay/agent.py:341-354). The pod's own provider.destroy() (or
     the loser-self-destruct path) tears the pod down; the row stays.
  if all racers now dead AND race_round < MAX_ROUNDS: CAS-increment race_round, fan out next N
  if rounds exhausted: phase='ended'/status='error'
resp { ack: true }
```

No change to the public surface; the dock keeps reading `/api/gpu/status` (which already builds
`srt://…` from `ip_address + srt_port + ingest_key`, status route lines 86-89).

---

## 6. Relay (agent.py) changes — small, additive

The relay media path is untouched. Only the boot/report logic changes:

1. **Read Vast env:** `PUBLIC_IPADDR`, `VAST_UDP_PORT_8890`, `VAST_TCP_PORT_1935`,
   `VAST_CONTAINERLABEL` (currently the agent reads NONE of these and sends only its ipify
   egress IP at pair, which the cloud correctly discards).
2. **On self-test PASS** (keep `_gpu_self_test()` BEFORE `start_mediamtx()` — do *not* reorder;
   reordering would green-light a GPU-broken host): after MediaMTX is up, `POST /api/agent/ready`
   with the env-derived ip/ports.
3. **On self-test FAIL:** `POST /api/agent/failed {machine_id, reason}` *before* the existing
   `sys.exit(1)` (today it exits silently and the broker must time out a probe to notice).
4. **Loser handling:** if a heartbeat or the `/ready` response says `self_destruct`, tear down
   (the pod already has `/root/.vast_api_key` and the teardown path).
5. `pair` can stay (it flips status and returns config) or be folded into `/ready`; keeping it
   is lower-risk for the flagged rollout.

These are necessary-but-not-sufficient on their own — they must ship with the broker-side race +
async (§7, §3) or the old synchronous cascade still overruns.

---

## 7. The parallel race coordinator (replaces gpu-broker.ts:234-331)

The serial `for` loop becomes a bounded-parallel fan-out:

- `rankedCandidates()` is unchanged (tier→distance→price, `lib/gpu-broker.ts:173-195`).
- Take the top **N (start at 2–3)**. `provider.create()` all N concurrently
  (`Promise.allSettled`). For each created pod, **append `{provider, provider_id}` to the row's
  `racers` jsonb before any further await** — the same orphan-safety principle as today's
  `onPodCreated` (line 251), so a kill leaves every racer reapable.
- Set `phase='racing'`, return. **No `waitForIp`, no `probeRtmp`, no `probeUdp` on the critical
  path** — readiness arrives via `/api/agent/ready`.
- **Winner selection** is the CAS in the `/ready` handler (§5): first ready racer flips the row
  to READY; later readies get `self_destruct`.
- **All racers fail** → `/failed` handler kicks the next round (guarded by `race_round`), reusing
  the next N ranked candidates.
- **Cancellation:** when the dock sends `DELETE /api/gpu` (Cancel / orphan), `teardownInstance()`
  destroys every pod in `racers` and clears the row. The broker also re-reads the row's existence
  before each create so a cancel mid-fan-out aborts the round.

`probeRtmp`/`probeUdp`/`waitForIp` are deleted from the provision path (kept only if a non-push
provider ever needs them; Vast won't). The RTMP `:1935` beacon stays on the pod (harmless, and
useful for the interim stopgap, §11).

---

## 8. Warm pool — the "instant" lever (sub-30s)

Vast's cold floor (~57s image pull + port mapping) can't be beaten on the cold path; the only way
under it is to not be cold.

- **Pool:** keep **K (1–2)** pods pre-booted, self-tested, MediaMTX up, ports mapped, idle —
  rows with `is_warm=true, user_id NULL`. Each warms with its OWN boot-time ingest key +
  passphrase, stored on its row.
- **Claim (atomic):** the provision route first tries
  `UPDATE … SET user_id=…, is_warm=false, phase='ready', status='running' WHERE id=(SELECT id …
  WHERE is_warm AND user_id IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`.
  `SKIP LOCKED` + the single-row update guarantee two simultaneous Go Lives can't grab the same
  pod. On hit, hand OBS that pod's stored `srt_url` immediately — **Go Live ≈ a few seconds.**
- **Rekey-on-claim — recommended approach: reuse the pod's own boot secret.** Because each pod
  serves exactly one user then is destroyed, the warm pod's boot-time ingest key + passphrase
  *become* this session's credentials — the cloud already stored them when warming, so claim just
  reads them onto the user's row. **No MediaMTX reconfigure, ~0s.** (The more-secure alternative —
  hot-reload MediaMTX with a fresh per-session passphrase via an `/api/agent/control` command,
  ~1–2s — is available if you ever want a fresh secret per session, but it's not needed: the pod
  is single-use and torn down on stop.)
- **Replenish:** a cron (`web/vercel.json`) or the always-on orchestrator (§10) tops the pool back
  to K in the background after each claim, and only runs the pool during configured active hours.
- **Cost:** an idle warm pod bills **~just the GPU rate ($0.10–0.30/hr)** — Vast bills bandwidth
  per-byte and an idle pod moves ~none. So K=1–2 during active hours ≈ **$30–90/mo per slot**
  (full math in chat). The cold race (§7) is the fallback whenever the pool is empty.

---

## 9. Self-hosted GPU as a provider (optional, cheapest path to "always instant")

Your broker already has a provider abstraction (`lib/providers/types.ts`, `ACTIVE_PROVIDERS`).
A self-hosted box is just another provider:

- `selfHostedProvider implements GpuProvider`:
  - `listCandidates()` → one **tier-0** candidate at the box's fixed coords, price ≈ 0.
  - `create()` → not a rent; an "attach" — (re)configure the box's MediaMTX for this session's
    key (HTTP/SSH control call) and return its static ip/ports. Effectively always warm.
  - `getStatus()` → the known static ip + ports. `destroy()` → deconfigure, **don't kill the box.**
- Put it ahead of Vast in `ACTIVE_PROVIDERS`; the existing ranking puts tier-0 first, so Go Live
  attaches to the box instantly and falls back to the Vast race only when the box is busy/down.
- **Honest caveats:** one box ≈ one concurrent multi-platform stream (consumer NVENC session cap);
  residential upload must sustain ~30 Mbps/stream; single point of failure (your power/ISP). Great
  for the solo/early-beta phase and the cheapest "instant"; keep Vast as the elastic overflow.

---

## 10. Where the orchestration runs (async mechanism)

The push-readiness model (I1) makes this simple: **there is almost no long-running background work
to babysit.** The provision POST does ~5s of bounded work (claim + N creates) and returns; every
subsequent transition is a *short* request driven by a pod POST (`/ready`/`/failed`) or the dock's
status poll. So the **primary mechanism is a poll-driven state machine on Vercel — no new infra.**

- **Replenishing the warm pool** and **kicking the next race round** are the only "who runs it when
  no request is in flight" cases. Use a **Vercel cron** (`web/vercel.json`) for pool replenish; the
  next-round kick lives in the `/failed` handler (a normal short request).
- **The always-on CPU orchestrator becomes worth it** only if you want the warm pool managed
  continuously/aggressively or you outgrow cron — a $4–6/mo box (Hetzner/Fly/Vast-CPU) running a
  persistent loop. It runs the *control plane* only; it can never transcode (no NVENC). Defer it
  until the warm pool's cron-based replenish proves insufficient.

---

## 11. INTERIM STOPGAP — ship today, before the rewrite

Your streams are broken now. These are small, safe, and forward-compatible (they don't conflict
with the rewrite). Ship in this order:

1. **Save `srt_port`/`ip`/`ingest_key` EARLY** — inside `onPodCreated` (or right after the SRT
   readiness check), not only in the terminal `.update` (`provision/route.ts:296-314`). A
   mid-cascade kill then can't strand a healthy pod with an unsaved URL. **Highest-value single
   change** — directly attacks audit mechanism C. *(This is exactly what §5 `/ready` does later;
   shipping it now is a stepping stone, not throwaway.)*
2. **Cut the per-host time tax:** lower `probeRtmp` timeout 10s→3s (a live MediaMTX answers in
   <100ms) and reduce `RTMP_PROBE_RETRIES` 3→2 (`gpu-broker.ts:37-38,58`). Caps the RTMP cost at
   ~7s instead of ~38s.
3. **Drop the advisory `probeUdp` from the awaited winner path** (`gpu-broker.ts:309`) — it can
   structurally never receive a reply from a serverless socket, yet costs up to 8s on the
   *winning* pod's critical path.
4. **Fast-abandon dead Vast containers** in `waitForIp` — treat `exited`/`stopped`/`offline` as
   terminal, reading `actual_status` not just `cur_state` (`gpu-broker.ts:139-153`; note
   `vast.ts:333` shadows `actual_status` with `cur_state`).
5. **Shrink the budget so one attempt fits:** `MAX_BOOT_ATTEMPTS` 5→**2** and
   `READINESS_TIMEOUT_MS` 180s→**~110s** (`datacenters.ts`), plus an elapsed-time guard that
   returns a clean retryable 503 instead of being hard-killed at 300s.
6. **Move `sweepStalePods()` off the critical path** (`provision/route.ts:36`) — make it
   fire-and-forget so it doesn't spend the budget before provisioning starts.

Expected effect: dramatically fewer mid-cascade kills and a far higher chance a stream starts
within budget — buys time to build the real fix without rushing it.

---

## 12. Build order (each phase independently shippable + testable)

- **Phase 0 — Stopgap (§11).** Hours. Stops the bleeding. No schema change.
- **Phase 1 — Push-readiness (§5, §6) + early-save.** Add `/api/agent/ready` + `/failed`; agent
  reads Vast env and POSTs them; row gets `srt_port` the instant the pod is healthy. Migration:
  `phase`, `racers`, `race_round`. Behind flag `SLIMCAST_BROKER_V2`. *Independently testable: one
  pod, no race — does the URL get saved by the pod itself?*
- **Phase 2 — Parallel race (§7) + async return (§3, I2/I3).** Provision returns 202; N racers;
  CAS winner; losers self-destruct; next-round kick. *This is the phase that fixes "streams won't
  start."* Steps 1–2 (Phase 1+2) alone get reliable ~30–60s cold starts.
- **Phase 3 — Warm pool (§8).** The sub-30s "instant" lever. Cron replenish.
- **Phase 4 — Self-hosted provider (§9)** and/or **always-on orchestrator (§10).** Optional, only
  if you want always-instant / cheapest.
- **Cutover:** run v2 behind `SLIMCAST_BROKER_V2` (env or %-of-users). Telemetry to compare:
  time-to-READY, time-to-STREAMING, success rate, attempts/round. Flip the flag to roll back
  instantly; both paths write the same row shape.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Race rents N pods but `UNIQUE(user_id)` allows one row | Track racers in the row's `racers` jsonb, not N rows; promote the winner |
| Two `/ready` POSTs race for the win | CAS on `phase='racing'`→`'ready'`; only one wins, the rest get `self_destruct` |
| Duplicate `/failed` double-kicks the next round | `race_round` CAS-increment guards the fan-out |
| Function killed mid-fan-out orphans a racer | Append to `racers` before any await; reaper scans `racers`; teardown is idempotent |
| Warm pod claimed by two Go Lives | `FOR UPDATE SKIP LOCKED` single-row claim |
| Pod self-reports wrong IP | Use `PUBLIC_IPADDR` (ingest), never ipify egress; OBS's SRT connect-retry covers the few-second port-forward lag |
| v2 regresses | Feature flag + identical row shape = instant rollback |

---

## 14. Open decisions for you

1. **How far down the build order do we go now?** Phases 0–2 (reliable <60s, no idle cost) is the
   floor; Phase 3 (warm pool, ~$30–90/mo) is "instant"; Phase 4 (self-host) is cheapest-instant
   for the solo phase. You leaned "instant" — so likely 0→3, with 4 as a follow-on.
2. **Warm pool now or after the cold race proves out?** Recommend building 0→2 first, measuring
   real cold-start, then adding the pool — defers idle spend until proven, and the pool is trivial
   on top of the clean model.
3. **N (racers per round):** start at **2** (datacenter hosts are reliable; 2 already removes the
   serial tax) and tune from telemetry. 3 if cold-start success rate needs it.
4. **Self-host box:** do you have a GPU you'd dedicate (which card / upload bandwidth)? That
   decides whether Phase 4 is worth speccing concretely.

---

Bottom line: keep the relay, rewrite the broker. Phase 0 stops the bleeding today; Phases 1–2 fix
"streams won't start" properly (~30–60s reliable); Phase 3 makes it feel instant.

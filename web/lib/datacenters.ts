// Tuning surface for the GPU availability broker (lib/gpu-broker.ts).
// Provider-agnostic policy knobs only — price ceiling, readiness timeouts, fallback
// geo. Per-provider catalogs/filters live in each provider module (providers/vast.ts).

// Never auto-provision a host above this all-in hourly price. Enforced twice: the
// provider's candidate filter (pricePerHr) AND the live cost guard against the
// provider's real reported price. This is the baseline (1080p) ceiling — 2K streams
// use a higher ceiling set at provision time in SLIMCAST_COST_CEILING_USD.
export const PRICE_CEILING = 0.50

// VPS-hub GPU BACKEND ceiling (the bridge race). Higher than the all-in-one ceiling
// because the backend's egress is tiny + in-region (it returns ONE H.264 stream to
// the VPS, not a platform fan-out), so the bandwidth component barely binds — and we
// need headroom for RunPod SECURE (~$0.99). Tune once real in-region GPU density near
// each Hetzner region is measured.
export const BACKEND_PRICE_CEILING = 1.00

// Readiness gate: after a pod is created we poll until it has a public IP + mapped
// ingest ports (i.e. it actually booted). If it never does within the timeout,
// abandon it and try the next candidate — inventory is not the same as a working
// pod.
// Phase 0 stopgap: 2 attempts × 110s = 220s — safely under the 300s Vercel ceiling
// even with RTMP probes. (Was 180s × 5 = 900s, which massively overran on slow hosts.)
export const READINESS_TIMEOUT_MS = 110_000
export const READINESS_POLL_MS = 5_000

// Cap how many pods we'll boot-and-abandon before giving up. Capacity misses
// (create rejected — no inventory) are fast and do NOT count; only a real pod that
// boots but never gets an IP counts. Keeps a pathological run inside the timeout.
// Phase 0 stopgap: reduced from 5 so two worst-case attempts stay under 300s.
export const MAX_BOOT_ATTEMPTS = 2

// Default location when the request carries no geo headers (local dev, VPNs):
// central US minimizes worst-case latency for an unknown US user.
export const FALLBACK_LAT = 39.0
export const FALLBACK_LON = -95.0

// ── VPS-as-the-Hub knobs (lib/vps-broker.ts) ─────────────────────────────────
// Never spawn a hub above this hourly price. Per §1b the cheapest 22TB-bundle hub
// (cx23) is ~$0.0104/hr; $0.20 leaves headroom up to ~cpx42/cx53 while still
// excluding the big dedicated boxes a passthrough hub never needs.
export const VPS_PRICE_CEILING = 0.20

// How long a spawning hub has to POST /api/agent/ready before the reaper abandons
// it. Generous because first boot includes a cloud-init docker-pull of the private
// relay image (Phase 4 prebuilt snapshot will shrink this).
export const VPS_READINESS_TIMEOUT_MS = 300_000

// Scale-to-zero (Clock B): a live hub with zero DERIVED live-lease tenants is
// destroyed after this idle grace, so brief gaps / quick restarts don't thrash
// the box. (empty_since is reconciled from the derived count, not a refcount.)
export const HUB_IDLE_GRACE_MS = 10 * 60 * 1000

// Default per-box tenant capacity (load-test §10.4 pending; the box is bandwidth-
// bound on its 22TB bundle, not CPU-bound, once the preview is off).
export const HUB_MAX_SESSIONS = 10

// ── Universal termination lease (termination-system-plan.md Phase 1) ─────────
// Two independent timers resolve the old "one 150s threshold doubles as both
// reconnect-tolerance AND orphan-reaping" tension (§9.1):
//
//   BOX lease — renewed by EVERY relay→Vercel heartbeat (~10s beat). A box whose
//   heartbeat stops is past this within ~12 missed beats and gets swept. It rides
//   the datacenter→Vercel link, NOT the user's home uplink, so user-side jitter
//   can never trip it. Applies to legacy pods (gpu_instances), GPU backends
//   (relay_nodes) and hub boxes (vps_hubs).
export const BOX_LEASE_MS = 120_000
//
//   TENANT reconnect lease — renewed ONLY while a hub tenant's OBS source is
//   present. Source absent this long → reap that tenant (and its GPU backend),
//   while a reconnect inside the window keeps the slot. Replaces the legacy 20s
//   OBS-disconnect kill with a forgiving 3 min (must match the 180s literal in
//   attach_session_to_hub's renew_deadline).
export const RECONNECT_GRACE_MS = 180_000
//
//   Backstop grace past the confirmable 12h max_session_at hard cap before a
//   forced kill (mirrors architecture #12).
export const MAX_SESSION_GRACE_S = 60
//
//   SWEEP SETTLE MARGIN (termination review #1/#9/#10/#13/#14). The box lease alone
//   (120s) reaps with a STRICT renew_deadline<now test, which races the relay's own
//   missed-heartbeat auto-resume and can mass-reap a recovering fleet on a >120s
//   control-plane (Vercel) outage: every relay freezes its lease during the outage,
//   then the first to recover sweeps the laggards before they re-heartbeat. The
//   sweeper therefore reaps only when the lease has been expired for an ADDITIONAL
//   settle margin, so the post-recovery heartbeat herd (each box re-beats within
//   ~1 POLL_INTERVAL) renews before anything is destroyed. Effective box-dead
//   threshold = BOX_LEASE_MS + SWEEP_GRACE_MS (~210s). A 3-min control-plane blip
//   (the review's scenario) never even flags a box. Paired with an atomic lease
//   re-validate at the destroy itself (teardownInstance conditional DELETE +
//   claim_hub_for_teardown re-check) so a laggard that re-beats mid-sweep is spared.
export const SWEEP_GRACE_MS = 90_000
//
//   PROVISION BOOT LEASE (termination review #4/#5). A freshly-claimed gpu_instances
//   row (legacy all-in-one pod) carries NO renew_deadline until its FIRST heartbeat,
//   and the sweeper treats a NULL lease as not-expired — so a pod that boots a real
//   box but whose agent dies before its first beat (GPU-injection crash, OOM, OBS/
//   laptop crash, both v2 racers silently dying) used to leak until the 12h
//   max_session cap. We stamp this boot-window lease at the claim INSERT and at the
//   /ready CAS (mirroring how vps-broker stamps hub/gpu-backend inserts), so a
//   never-heartbeating box is swept in ~PROVISION_LEASE_MS+grace instead of ~12h.
//   Sized to cover the worst-case boot+pair+first-beat (MAX_BOOT_ATTEMPTS × readiness
//   ≈ 220s) so a slow-but-valid boot is never false-reaped. Also the age threshold
//   for the NULL-lease backstop in the sweeper (defense-in-depth for any insert path
//   that forgets to stamp).
export const PROVISION_LEASE_MS = 300_000

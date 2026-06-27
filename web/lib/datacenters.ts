// Tuning surface for the GPU availability broker (lib/gpu-broker.ts).
// Provider-agnostic policy knobs only — price ceiling, readiness timeouts, fallback
// geo. Per-provider catalogs/filters live in each provider module (providers/vast.ts).

// Never auto-provision a host above this all-in hourly price. Enforced twice: the
// provider's candidate filter (pricePerHr) AND the live cost guard against the
// provider's real reported price. This is the baseline (1080p) ceiling — 2K streams
// use a higher ceiling set at provision time in SLIMCAST_COST_CEILING_USD.
export const PRICE_CEILING = 0.50

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

// Scale-to-zero (Clock B): a live hub with session_count==0 is destroyed after this
// idle grace, so brief gaps / quick restarts don't thrash the box.
export const HUB_IDLE_GRACE_MS = 10 * 60 * 1000

// Default per-box tenant capacity (load-test §10.4 pending; the box is bandwidth-
// bound on its 22TB bundle, not CPU-bound, once the preview is off).
export const HUB_MAX_SESSIONS = 10

// Tuning surface for the GPU availability broker (lib/gpu-broker.ts).
// Provider-agnostic policy knobs only — price ceiling, readiness timeouts, fallback
// geo. Per-provider catalogs/filters live in each provider module (providers/vast.ts).

// Never auto-provision a host above this all-in hourly price. Enforced twice: the
// provider's candidate filter (pricePerHr) AND the live cost guard against the
// provider's real reported price.
export const PRICE_CEILING = 1.00

// Readiness gate: after a pod is created we poll until it has a public IP + mapped
// ingest ports (i.e. it actually booted). If it never does within the timeout,
// abandon it and try the next candidate — inventory is not the same as a working
// pod. Vast fresh hosts pull the full relay image every rent (~83s measured on an
// 800Mbps host), so 180s gives margin on slower hosts while staying well under
// Vercel's 300s function limit.
export const READINESS_TIMEOUT_MS = 180_000
export const READINESS_POLL_MS = 5_000

// Cap how many pods we'll boot-and-abandon before giving up. Capacity misses
// (create rejected — no inventory) are fast and do NOT count; only a real pod that
// boots but never gets an IP counts. Keeps a pathological run inside the timeout.
export const MAX_BOOT_ATTEMPTS = 5

// Default location when the request carries no geo headers (local dev, VPNs):
// central US minimizes worst-case latency for an unknown US user.
export const FALLBACK_LAT = 39.0
export const FALLBACK_LON = -95.0

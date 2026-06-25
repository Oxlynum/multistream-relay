import type { GpuProvider, GpuCandidate } from './types'

// Vast.ai provider — SCAFFOLD, not yet wired into ACTIVE_PROVIDERS.
//
// Vast is a marketplace: instead of pinning a datacenter, you search live offers
// (each offer = a specific machine with a known GPU, price, and geolocation) and
// rent one. That maps cleanly onto our location-stamped candidate model — each
// offer becomes a GpuCandidate with the machine's real coordinates, so Vast
// offers rank against RunPod datacenters by distance automatically.
//
// IMPLEMENTATION IS DELIBERATELY DEFERRED until we verify the live API shape with
// scripts/test-vast.mjs (the same "probe before you trust the API" discipline that
// caught RunPod's DC-list and stock-status surprises). The probe will confirm:
//   • offer search endpoint + query format (GET /api/v0/bundles?q=...)
//   • the exact fields: gpu_name, dph_total (price), geolocation (string like
//     "US, California" — needs mapping to lat/lon), reliability2, cuda/driver,
//     inet_up/down (bandwidth matters for streaming), rentable/verified flags
//   • the rent/create + destroy endpoints and the port-mapping shape
// Once verified, fill the methods below and add vastProvider to ACTIVE_PROVIDERS
// + the PROVIDERS registry in runpod.ts.

const VAST_API_KEY = process.env.VAST_API_KEY

export const vastProvider: GpuProvider = {
  name: 'vast',

  async listCandidates(): Promise<GpuCandidate[]> {
    if (!VAST_API_KEY) return []
    // TODO(vast): GET offers, filter to NVENC-capable (Turing+) GPUs that are
    // verified + rentable + on-demand + ≤ maxPricePerHr with adequate upload
    // bandwidth, map each offer's geolocation → {lat,lon}, return as candidates
    // with placement: { offerId }. Until verified, contribute nothing.
    return []
  },

  async create(): Promise<never> {
    throw new Error('vast provider not implemented yet — run scripts/test-vast.mjs to verify the API, then implement')
  },

  async getStatus(): Promise<never> {
    throw new Error('vast provider not implemented yet')
  },

  async stop(): Promise<void> {
    throw new Error('vast provider not implemented yet')
  },

  async destroy(): Promise<void> {
    throw new Error('vast provider not implemented yet')
  },
}

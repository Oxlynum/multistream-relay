import { createPod, getPodStatus, stopPod, destroyPod } from '@/lib/runpod'
import { GPU_CATALOG, RUNPOD_DATACENTERS, RUNPOD_CLOUD_TYPE } from '@/lib/datacenters'
import type { GpuProvider, GpuCandidate } from './types'

export const runpodProvider: GpuProvider = {
  name: 'runpod',

  // Cartesian product of (affordable catalog GPUs) × (secure datacenters), each
  // stamped with its datacenter's coordinates. The broker ranks these by distance
  // to the user and creates nearest-first. We do NOT consult a stock API here —
  // RunPod's per-DC stock query is unreliable (it disagreed with the console), so
  // create() is the source of truth: a dry DC fails fast and the broker cascades.
  async listCandidates({ maxPricePerHr, needsProfessionalGpu }) {
    const gpus = GPU_CATALOG
      .filter(g => g.pricePerHr <= maxPricePerHr)
      .filter(g => !needsProfessionalGpu || !g.consumerGpu)

    const out: GpuCandidate[] = []
    for (const dc of RUNPOD_DATACENTERS) {
      for (const g of gpus) {
        out.push({
          provider: 'runpod',
          gpuKey: g.key,
          gpuTypeId: g.runpodId,
          pricePerHr: g.pricePerHr,
          lat: dc.lat,
          lon: dc.lon,
          label: dc.id,
          placement: { datacenterId: dc.id },
        })
      }
    }
    return out
  },

  async create({ candidate, name, imageTag, env }) {
    const datacenterId = candidate.placement.datacenterId as string
    // Single-DC pin on SECURE cloud → RunPod places the pod in exactly this DC
    // (verified) and reports it back, so no post-boot geolocation is needed.
    return createPod({
      name,
      imageTag,
      env,
      gpuTypeId: candidate.gpuTypeId,
      cloudType: RUNPOD_CLOUD_TYPE,
      dataCenterIds: [datacenterId],
    })
  },

  getStatus: (podId) => getPodStatus(podId),
  stop: (podId) => stopPod(podId),
  destroy: (podId) => destroyPod(podId),
}

// All providers the broker ranks across, in no particular order (the broker sorts
// every candidate by distance). Vast.ai joins here once its implementation is
// verified against the live API — see lib/providers/vast.ts.
export const ACTIVE_PROVIDERS: GpuProvider[] = [runpodProvider]

const PROVIDERS: Record<string, GpuProvider> = {
  runpod: runpodProvider,
  // vast: vastProvider,   // wire in after the live-API probe (scripts/test-vast.mjs)
}

/** Resolve the provider that owns an existing instance (for stop/teardown). */
export function getProvider(name: string | null | undefined): GpuProvider {
  return PROVIDERS[name ?? 'runpod'] ?? runpodProvider
}

import { createPod, getPodStatus, stopPod, destroyPod, listPods } from '@/lib/runpod'
import { GPU_CATALOG, RUNPOD_DATACENTERS, RUNPOD_CLOUD_TYPE } from '@/lib/datacenters'
import { vastProvider } from './vast'
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
  // listPods returns { id, name } already — RunPod names pods `slimcast-<userid8>`.
  listInstances: () => listPods(),
}

// All providers the broker ranks across, in no particular order (the broker sorts
// every candidate by distance). Both place deterministically: RunPod secure pins a
// datacenter; Vast rents a specific machine at a known location.
//
// Vast enabled alongside RunPod. Inbound is solid (RTMP readiness probe). Known
// open issue under investigation: the OUTBOUND leg (pod → Twitch) can fail on some
// consumer Vast hosts that restrict outbound — being addressed with a pod-side
// outbound readiness self-test so the broker only uses hosts that can deliver.
export const ACTIVE_PROVIDERS: GpuProvider[] = [runpodProvider, vastProvider]

const PROVIDERS: Record<string, GpuProvider> = {
  runpod: runpodProvider,
  vast: vastProvider,
}

/** Resolve the provider that owns an existing instance (for stop/teardown). */
export function getProvider(name: string | null | undefined): GpuProvider {
  return PROVIDERS[name ?? 'runpod'] ?? runpodProvider
}

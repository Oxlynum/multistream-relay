import { createPod, getPodStatus, stopPod, destroyPod } from '@/lib/runpod'
import type { GpuProvider } from './types'

export const runpodProvider: GpuProvider = {
  name: 'runpod',

  async create({ candidate, name, imageTag, env }) {
    return createPod({
      name,
      imageTag,
      env,
      gpuTypeId: candidate.gpuTypeId,
      cloudType: candidate.cloudType,
      dataCenterIds: candidate.datacenterIds,
    })
  },

  getStatus: (podId) => getPodStatus(podId),
  stop: (podId) => stopPod(podId),
  destroy: (podId) => destroyPod(podId),
}

const PROVIDERS: Record<string, GpuProvider> = {
  runpod: runpodProvider,
  // vultr: vultrProvider,   // drop-in later (datacenter-grade reliability + SRT)
  // vast:  vastProvider,    // drop-in later (cheap consumer-GPU breadth)
}

// All providers the broker should try, in priority order.
export const ACTIVE_PROVIDERS: GpuProvider[] = [runpodProvider]

/** Resolve the provider that owns an existing instance (for stop/teardown). */
export function getProvider(name: string | null | undefined): GpuProvider {
  return PROVIDERS[name ?? 'runpod'] ?? runpodProvider
}

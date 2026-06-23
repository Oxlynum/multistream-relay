import type { GpuGen } from '@/lib/datacenters'

export interface PodEnv {
  key: string
  value: string
}

// One concrete thing to try: a GPU type, on a cloud type, restricted to a
// proximity-ordered set of datacenters. The broker walks a ranked list of these.
export interface GpuCandidate {
  gpuKey: string
  gpuTypeId: string
  gen: GpuGen
  pricePerHr: number
  cloudType: string
  datacenterIds: string[]
  tier: 'near' | 'mid' | 'far'
}

export interface CreatedPod {
  podId: string
  costPerHr?: number   // actual hourly price, if the provider reports it
}

export interface PodStatus {
  status: string
  ip: string | null
  port: number | null   // public mapped port for the RTMP ingest (1935)
}

// A cloud GPU provider. RunPod is implemented today; Vultr / Vast.ai slot in as
// additional implementations and the broker cascades across all of them.
export interface GpuProvider {
  name: string
  create(args: {
    candidate: GpuCandidate
    name: string
    imageTag: string
    env: PodEnv[]
  }): Promise<CreatedPod>
  getStatus(podId: string): Promise<PodStatus>
  stop(podId: string): Promise<void>
  destroy(podId: string): Promise<void>
}

import { createPod, getPodStatus, stopPod, destroyPod, listPods, BRIDGE_IN_PORT } from '@/lib/runpod'
import type { GpuProvider, GpuCandidate, PodStatus, CreatedPod } from './types'
import { ownerOfPodName } from '../managed-identity'

// RunPod GPU provider — VPS-hub GPU BACKEND only (never an OBS-ingest pod).
//
// Recovered + adapted from git 070ed53^ (removed when SRT/UDP ingest banned TCP-only
// RunPod). The hub's GPU bridge is mpegts-over-TCP, so RunPod is viable again — and
// REQUIRED: Vast's catalog is too limited to be the sole backend. RunPod SECURE pins a
// datacenter and reports it, so the broker can place a GPU near the VPS hub.
//
// Provider mechanics match the current candidate/placement model: the broker merges
// these candidates with Vast's and ranks ALL of them by distance to the hub.

// RunPod SECURE datacenters the REST POST /pods enum actually builds in, with coords
// for proximity ranking (NOT the larger GraphQL list — pinning a GraphQL-only DC
// hard-fails create). Keep in sync with the enum RunPod returns in a 400.
const RUNPOD_DATACENTERS: Array<{ id: string; lat: number; lon: number }> = [
  { id: 'US-GA-1', lat: 33.75, lon: -84.39 }, { id: 'US-GA-2', lat: 33.75, lon: -84.39 },
  { id: 'US-NC-1', lat: 35.23, lon: -80.84 }, { id: 'US-DE-1', lat: 39.16, lon: -75.52 },
  { id: 'US-MD-1', lat: 39.05, lon: -76.64 }, { id: 'US-IL-1', lat: 41.88, lon: -87.63 },
  { id: 'US-KS-2', lat: 39.05, lon: -95.70 }, { id: 'US-KS-3', lat: 39.05, lon: -95.70 },
  { id: 'US-TX-1', lat: 32.78, lon: -96.80 }, { id: 'US-TX-3', lat: 32.78, lon: -96.80 },
  { id: 'US-TX-4', lat: 32.78, lon: -96.80 }, { id: 'US-CA-2', lat: 37.40, lon: -122.10 },
  { id: 'US-WA-1', lat: 47.61, lon: -122.33 },
  { id: 'CA-MTL-1', lat: 45.50, lon: -73.57 }, { id: 'CA-MTL-2', lat: 45.50, lon: -73.57 },
  { id: 'CA-MTL-3', lat: 45.50, lon: -73.57 },
  { id: 'EU-CZ-1', lat: 50.08, lon: 14.43 }, { id: 'EU-FR-1', lat: 48.85, lon: 2.35 },
  { id: 'EU-NL-1', lat: 52.37, lon: 4.90 }, { id: 'EU-RO-1', lat: 44.43, lon: 26.10 },
  { id: 'EU-SE-1', lat: 59.33, lon: 18.07 }, { id: 'EUR-IS-1', lat: 64.13, lon: -21.93 },
  { id: 'EUR-IS-2', lat: 64.13, lon: -21.93 }, { id: 'EUR-IS-3', lat: 64.13, lon: -21.93 },
  { id: 'EUR-NO-1', lat: 59.91, lon: 10.75 },
  { id: 'AP-IN-1', lat: 19.08, lon: 72.88 }, { id: 'AP-JP-1', lat: 35.68, lon: 139.69 },
  { id: 'OC-AU-1', lat: -33.87, lon: 151.21 },
]

interface RunpodGpuSpec { key: string; runpodId: string; pricePerHr: number; consumerGpu?: boolean }

// NVENC-capable cards on RunPod SECURE, Turing+ (relay's p7 preset + B-frames need
// it), ≤ ceiling. consumerGpu (GeForce) → 3-session NVENC cap (broker skips when the
// user needs >3). Excludes the encoder-less compute dies (A100/H100/H200/B200/V100).
const GPU_CATALOG: RunpodGpuSpec[] = [
  { key: 'rtx2000ada', runpodId: 'NVIDIA RTX 2000 Ada Generation', pricePerHr: 0.24 },
  { key: 'a4000',      runpodId: 'NVIDIA RTX A4000',               pricePerHr: 0.25 },
  { key: 'a4500',      runpodId: 'NVIDIA RTX A4500',               pricePerHr: 0.25 },
  { key: 'rtx4000ada', runpodId: 'NVIDIA RTX 4000 Ada Generation', pricePerHr: 0.26 },
  { key: 'a5000',      runpodId: 'NVIDIA RTX A5000',               pricePerHr: 0.27 },
  { key: 'l4',         runpodId: 'NVIDIA L4',                      pricePerHr: 0.39 },
  { key: 'a40',        runpodId: 'NVIDIA A40',                     pricePerHr: 0.44 },
  { key: 'rtx3090',    runpodId: 'NVIDIA GeForce RTX 3090',        pricePerHr: 0.46, consumerGpu: true },
  { key: 'a6000',      runpodId: 'NVIDIA RTX A6000',               pricePerHr: 0.49 },
  { key: 'rtxpro4000', runpodId: 'NVIDIA RTX PRO 4000 Blackwell',  pricePerHr: 0.57 },
  { key: 'rtx4090',    runpodId: 'NVIDIA GeForce RTX 4090',        pricePerHr: 0.69, consumerGpu: true },
  { key: 'rtxpro4500', runpodId: 'NVIDIA RTX PRO 4500 Blackwell',  pricePerHr: 0.74 },
  { key: 'rtx6000ada', runpodId: 'NVIDIA RTX 6000 Ada Generation', pricePerHr: 0.77 },
  { key: 'l40',        runpodId: 'NVIDIA L40',                     pricePerHr: 0.82 },
  { key: 'rtx5090',    runpodId: 'NVIDIA GeForce RTX 5090',        pricePerHr: 0.99, consumerGpu: true },
  { key: 'l40s',       runpodId: 'NVIDIA L40S',                    pricePerHr: 0.99 },
]

// SECURE only: honors the pinned datacenter + reports it back (deterministic "near
// the hub" placement). COMMUNITY ignores the pin and places globally at random.
const RUNPOD_CLOUD_TYPE = 'SECURE'

export const runpodProvider: GpuProvider = {
  name: 'runpod',

  // Cartesian (affordable catalog GPUs) × (secure datacenters), each stamped with the
  // DC's coordinates. The broker ranks by distance to the hub and creates nearest-first;
  // a dry DC fails fast on create() and the broker cascades. RunPod is backend-only, so
  // the 'mode' is effectively always 'backend' here (it's never an SRT-ingest pod).
  async listCandidates({ maxPricePerHr, needsProfessionalGpu }) {
    if (!process.env.RUNPOD_API_KEY) return []
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
          label: `runpod:${dc.id} ${g.key} $${g.pricePerHr}`,
          placement: { datacenterId: dc.id, gpuRateUsd: g.pricePerHr, egressUsdPerTb: 0, ingressUsdPerTb: 0 },
        })
      }
    }
    return out
  },

  async create({ candidate, name, imageTag, env }): Promise<CreatedPod> {
    const datacenterId = candidate.placement.datacenterId as string
    // Provider-neutral self-identity so relay/agent.py doesn't hardcode RunPod's env
    // names for the bridge port / self-id (Phase 2, item 5).
    const envWithProvider = [...env, { key: 'SLIMCAST_PROVIDER', value: 'runpod' }]
    // createPod defaults ports to [`${BRIDGE_IN_PORT}/tcp`] — the bridge-in TCP port,
    // the only inbound the GPU backend needs (the RTMPS return is outbound).
    const created = await createPod({
      name, imageTag, env: envWithProvider,
      gpuTypeId: candidate.gpuTypeId,
      cloudType: RUNPOD_CLOUD_TYPE,
      dataCenterIds: [datacenterId],
      ports: [`${BRIDGE_IN_PORT}/tcp`],
    })
    return { podId: created.podId, costPerHr: created.costPerHr ?? candidate.pricePerHr }
  },

  getStatus: (podId): Promise<PodStatus> => getPodStatus(podId),
  stop: (podId) => stopPod(podId),
  destroy: (podId) => destroyPod(podId),

  // OUR pods only. RunPod's REST GET /pods returns the WHOLE account with no server-side
  // filter (and listPods() throws without a key), so the managed-name prefix filter here
  // is LOAD-BEARING for safety: the reaper destroys whatever this returns that has no DB
  // row, so an unrelated account pod must never leak through. `ownerId` feeds the reaper's
  // mid-provision guard.
  async listInstances(): Promise<Array<{ id: string; name: string; ownerId: string | null }>> {
    if (!process.env.RUNPOD_API_KEY) return []
    try {
      const pods = await listPods()
      // Hub-EXCLUSIVE (see vast.ts): ownerOfPodName != null excludes non-slimcast pods AND
      // hub names, and guarantees a non-null ownerId for the reaper's mid-provision guard.
      return pods
        .filter(p => ownerOfPodName(p.name) != null)
        .map(p => ({ id: p.id, name: p.name, ownerId: ownerOfPodName(p.name) }))
    } catch (err) {
      console.error('[runpod] list pods failed:', err instanceof Error ? err.message : err)
      return []
    }
  },
}

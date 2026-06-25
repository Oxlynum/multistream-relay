import net from 'net'

// TCP probe: verify the RTMP port is actually forwarding before we hand the
// address to OBS. RunPod GraphQL reports the mapping before the tunnel is fully
// wired up on community cloud; this catches broken port mappings and lets the
// broker cascade to a different pod automatically.
function probeTcp(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(port, host)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error',   () => { clearTimeout(timer); resolve(false) })
  })
}

// GPU availability broker.
//
// Instead of "give me an L4 in this DC → fail if dry", this generates a ranked
// list of {gpu × cloud × datacenters} candidates and tries each until one both
// provisions AND boots. A capacity miss is a fast API rejection, so cascading
// through many candidates costs seconds; only a real boot incurs the ~45s wait.
//
// Ranking policy:
//   1. Latency tier first (near ≤40ms, then mid ≤70ms, then far) — under ~40ms
//      latency is imperceptible for buffered streaming, so within a tier we
//      optimize purely for cost.
//   2. Within a tier: cheapest acceptable GPU first (Ada preferred on near-ties).
//   3. Cloud type order (community first).

import {
  RUNPOD_DATACENTERS, GPU_CATALOG, PRICE_CEILING, ADA_SORT_BONUS,
  PRIMARY_MAX_KM, PRIMARY_MAX_COUNT, SECONDARY_MAX_KM, SECONDARY_MAX_COUNT,
  CLOUD_TYPES, READINESS_TIMEOUT_MS, READINESS_POLL_MS, MAX_BOOT_ATTEMPTS,
  MAX_RTT_REJECTIONS,
  type Datacenter,
} from '@/lib/datacenters'
import { fetchDatacenterIds } from '@/lib/runpod'
import { ACTIVE_PROVIDERS } from '@/lib/providers/runpod'
import type { GpuCandidate, GpuProvider, PodEnv } from '@/lib/providers/types'
import { requiredNvencSessions, type UserOutputConfig } from '@/lib/nvenc-utils'
export type { UserOutputConfig } from '@/lib/nvenc-utils'

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLon = ((bLon - aLon) * Math.PI) / 180
  const lat1 = (aLat * Math.PI) / 180
  const lat2 = (bLat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Cheapest first; Ada gets a small bonus so it wins only on near-ties.
function gpuSortScore(pricePerHr: number, gen: string): number {
  return pricePerHr - (gen === 'ada' ? ADA_SORT_BONUS : 0)
}

/** Build the ranked candidate list for a user at (lat, lon). */
export function rankCandidates(lat: number, lon: number, needsProfessionalGpu = false, datacenters: Datacenter[] = RUNPOD_DATACENTERS): GpuCandidate[] {
  // Sort every available DC by straight-line distance from the user — closest first.
  // This gives automatic subregion filtering: a Seattle user gets Pacific-coast DCs,
  // a Paris user gets Western EU DCs, etc., without any manual region selection.
  const sorted = [...datacenters]
    .map(dc => ({ dc, distKm: haversineKm(lat, lon, dc.lat, dc.lon) }))
    .sort((a, b) => a.distKm - b.distKm)

  // Three rings: primary (tight local subregion), secondary (same continent),
  // tertiary (global fallback). Distance caps prevent e.g. Kansas landing in
  // Seattle's primary ring (2340km) or Montreal in London's (5221km).
  // Always include the nearest DC in primary so remote/VPN users aren't stranded.
  const nearest = sorted[0]
  const primaryDcs = sorted
    .filter(x => x.distKm <= PRIMARY_MAX_KM || x.dc.id === nearest?.dc.id)
    .slice(0, PRIMARY_MAX_COUNT)
    .map(x => x.dc)
  const primaryIds = new Set(primaryDcs.map(dc => dc.id))
  const secondaryDcs = sorted
    .filter(x => !primaryIds.has(x.dc.id) && x.distKm <= SECONDARY_MAX_KM)
    .slice(0, SECONDARY_MAX_COUNT)
    .map(x => x.dc)
  const secondaryIds = new Set([...primaryIds, ...secondaryDcs.map(dc => dc.id)])
  const tertiaryDcs = sorted.filter(x => !secondaryIds.has(x.dc.id)).map(x => x.dc)

  if (sorted.length > 0) {
    const nearest = sorted[0]
    console.log(`[broker] subregion: [${primaryDcs.map(d => d.id).join(', ')}] (nearest: ${nearest.dc.id} ${nearest.distKm.toFixed(0)}km)`)
  }

  const gpus = GPU_CATALOG
    .filter(g => g.pricePerHr <= PRICE_CEILING)
    .filter(g => !needsProfessionalGpu || !g.consumerGpu)
    .sort((a, b) => gpuSortScore(a.pricePerHr, a.gen) - gpuSortScore(b.pricePerHr, b.gen))

  const candidates: GpuCandidate[] = []
  for (const [tier, dcs] of [['near', primaryDcs], ['mid', secondaryDcs], ['far', tertiaryDcs]] as const) {
    if (dcs.length === 0) continue
    const dcIds = dcs.map(dc => dc.id)
    for (const cloudType of CLOUD_TYPES) {
      for (const gpu of gpus) {
        candidates.push({
          gpuKey: gpu.key,
          gpuTypeId: gpu.runpodId,
          gen: gpu.gen,
          pricePerHr: gpu.pricePerHr,
          cloudType,
          datacenterIds: dcIds,
          tier,
        })
      }
    }
  }
  return candidates
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Poll until the pod reports a public IP + mapped RTMP port (booted), or time out. */
async function waitForIp(provider: GpuProvider, podId: string): Promise<{ ip: string; port: number; hlsPort: number | null; dataCenterId: string | null } | null> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const s = await provider.getStatus(podId)
      if (s.ip && s.port) return { ip: s.ip, port: s.port, hlsPort: s.hlsPort ?? null, dataCenterId: s.dataCenterId ?? null }
      if (s.status === 'error' || s.status === 'terminated') return null
    } catch {
      // transient API error — keep polling within the budget
    }
    await sleep(READINESS_POLL_MS)
  }
  return null
}

export interface ProvisionResult {
  ok: boolean
  provider?: string
  podId?: string
  ip?: string
  port?: number
  hlsPort?: number | null
  gpuKey?: string
  datacenter?: string
  pricePerHr?: number
  attempts: number
  error?: string
}

/**
 * Cascade across providers × candidates until one boots. Returns the winning
 * pod, or ok:false if every option was exhausted (vanishingly rare at launch
 * scale with multi-DC + multi-GPU breadth).
 */
export async function provisionGpu(args: {
  lat: number
  lon: number
  name: string
  imageTag: string
  env: PodEnv[]
  userOutputs?: UserOutputConfig[]
}): Promise<ProvisionResult> {
  const nvencSessions = args.userOutputs ? requiredNvencSessions(args.userOutputs) : 0
  const needsProfessionalGpu = nvencSessions > 3
  if (needsProfessionalGpu) {
    console.log(`[broker] user needs ${nvencSessions} NVENC sessions — skipping consumer GPUs`)
  }

  // Fetch the live set of valid datacenter IDs from RunPod so we never send
  // an ID the API no longer recognises (causes a 400 for the whole request).
  // On failure we fall back to omitting dataCenterIds (RunPod places freely;
  // the RTT gate below still rejects wrong-region pods after the fact).
  const liveDcIds = await fetchDatacenterIds()
  const datacenters = liveDcIds
    ? RUNPOD_DATACENTERS.filter(dc => liveDcIds.has(dc.id))
    : RUNPOD_DATACENTERS
  if (liveDcIds) {
    console.log(`[broker] live DCs from RunPod: ${datacenters.length} of ${RUNPOD_DATACENTERS.length} in our map`)
  } else {
    console.warn('[broker] could not fetch live DC list from RunPod — proceeding without DC filter')
  }

  const candidates = rankCandidates(args.lat, args.lon, needsProfessionalGpu, datacenters)
  let attempts = 0
  let bootAttempts = 0
  let rttRejections = 0
  let lastError: string | undefined

  for (const provider of ACTIVE_PROVIDERS) {
    for (const candidate of candidates) {
      attempts++
      let podId: string
      let actualCost: number | undefined
      try {
        const created = await provider.create({
          candidate,
          name: args.name,
          imageTag: args.imageTag,
          env: args.env,
        })
        podId = created.podId
        actualCost = created.costPerHr
      } catch (err) {
        // No capacity / rejected — fast miss, move to the next candidate.
        lastError = err instanceof Error ? err.message : String(err)
        console.error(`[broker] ${provider.name} ${candidate.gpuKey} @ ${candidate.datacenterIds[0]} (${candidate.cloudType}) failed:`, lastError)
        continue
      }

      // Hard price guard: if the provider reports an actual hourly cost above
      // the ceiling (live price differs from our catalog estimate), refuse it
      // and cascade on — we never want to silently exceed PRICE_CEILING.
      if (actualCost !== undefined && actualCost > PRICE_CEILING) {
        try { await provider.destroy(podId) } catch { /* best effort */ }
        lastError = `price ${actualCost} exceeds ceiling ${PRICE_CEILING}`
        continue
      }

      // Got inventory — now make sure it actually boots (IP + mapped port).
      bootAttempts++
      const addr = await waitForIp(provider, podId)
      if (addr) {
        // Verify the RTMP port is actually reachable. RunPod community cloud
        // reports port mappings in GraphQL before the TCP tunnel is live; a
        // probe here catches broken forwarding and lets us cascade automatically.
        const reachable = await probeTcp(addr.ip, addr.port)
        if (!reachable) {
          console.warn(`[broker] pod ${podId} RTMP ${addr.ip}:${addr.port} unreachable — tunnel failure, cascading`)
          try { await provider.destroy(podId) } catch { /* best effort */ }
          lastError = 'RTMP port unreachable (RunPod tunnel not set up)'
          if (bootAttempts >= MAX_BOOT_ATTEMPTS) {
            return { ok: false, attempts, error: 'too many failed boots' }
          }
          continue
        }

        // Verify RunPod honored our dataCenterIds hint by checking the actual DC
        // is in the set we requested. RunPod community cloud sometimes ignores
        // the hint and boots wherever it has inventory; this catches it.
        // Unknown DC (null) → can't verify, accept with a warning rather than
        // destroying a potentially-good pod over a metadata gap.
        if (addr.dataCenterId != null) {
          if (!RUNPOD_DATACENTERS.find(dc => dc.id === addr.dataCenterId)) {
            console.warn(`[broker] pod ${podId} has unrecognised DC '${addr.dataCenterId}' — cascading`)
            try { await provider.destroy(podId) } catch { /* best effort */ }
            lastError = `unrecognised datacenter: ${addr.dataCenterId}`
            bootAttempts--
            continue
          }
          if (!candidate.datacenterIds.includes(addr.dataCenterId)) {
            rttRejections++
            const wrongDc = RUNPOD_DATACENTERS.find(dc => dc.id === addr.dataCenterId)
            const distKm = wrongDc ? haversineKm(args.lat, args.lon, wrongDc.lat, wrongDc.lon).toFixed(0) : '?'
            console.warn(`[broker] pod ${podId} placed in ${addr.dataCenterId} (${distKm}km) — outside requested subregion (rejection ${rttRejections}/${MAX_RTT_REJECTIONS})`)
            try { await provider.destroy(podId) } catch { /* best effort */ }
            lastError = `wrong subregion: placed in ${addr.dataCenterId}`
            bootAttempts--
            if (rttRejections >= MAX_RTT_REJECTIONS) {
              return { ok: false, attempts, error: `No GPU capacity near you right now — try again in a few minutes when local inventory refreshes.` }
            }
            continue
          }
        } else {
          console.warn(`[broker] pod ${podId} has null dataCenterId — accepting without subregion verification`)
        }

        return {
          ok: true,
          provider: provider.name,
          podId,
          ip: addr.ip,
          port: addr.port,
          hlsPort: addr.hlsPort,
          gpuKey: candidate.gpuKey,
          datacenter: candidate.datacenterIds[0],
          pricePerHr: actualCost ?? candidate.pricePerHr,
          attempts,
        }
      }

      // Created but never booted — abandon it and keep cascading.
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'pod created but failed to boot'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) {
        return { ok: false, attempts, error: 'too many failed boots' }
      }
    }
  }

  return { ok: false, attempts, error: lastError ?? 'no capacity available' }
}

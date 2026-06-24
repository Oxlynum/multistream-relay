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
  LATENCY_NEAR_MS, LATENCY_MID_MS, CLOUD_TYPES,
  READINESS_TIMEOUT_MS, READINESS_POLL_MS, MAX_BOOT_ATTEMPTS,
  MAX_PROVISION_RTT_MS,
  type Datacenter,
} from '@/lib/datacenters'
import { ACTIVE_PROVIDERS } from '@/lib/providers/runpod'
import type { GpuCandidate, GpuProvider, PodEnv } from '@/lib/providers/types'

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

// Rough real-world RTT estimate: fiber light-speed plus a routing fudge factor
// (real routes are ~1.5× the great-circle path) plus fixed overhead.
function estimateRttMs(distanceKm: number): number {
  return (distanceKm / 100) * 1.5 + 10
}

function tierFor(rttMs: number): 'near' | 'mid' | 'far' {
  if (rttMs <= LATENCY_NEAR_MS) return 'near'
  if (rttMs <= LATENCY_MID_MS) return 'mid'
  return 'far'
}

// Cheapest first; Ada gets a small bonus so it wins only on near-ties.
function gpuSortScore(pricePerHr: number, gen: string): number {
  return pricePerHr - (gen === 'ada' ? ADA_SORT_BONUS : 0)
}

/** Build the ranked candidate list for a user at (lat, lon). */
export function rankCandidates(lat: number, lon: number): GpuCandidate[] {
  // Annotate each datacenter with its tier + rtt, grouped by tier.
  const byTier: Record<'near' | 'mid' | 'far', Array<Datacenter & { rtt: number }>> = {
    near: [], mid: [], far: [],
  }
  let anyWithinBound = false
  for (const dc of RUNPOD_DATACENTERS) {
    const rtt = estimateRttMs(haversineKm(lat, lon, dc.lat, dc.lon))
    if (rtt <= MAX_PROVISION_RTT_MS) anyWithinBound = true
    byTier[tierFor(rtt)].push({ ...dc, rtt })
  }

  // Region beats price: exclude any DC over the RTT ceiling unless there are
  // no in-bound DCs at all (VPN / unusual geo → allow the nearest far DC).
  if (anyWithinBound) {
    for (const tier of ['near', 'mid', 'far'] as const) {
      byTier[tier] = byTier[tier].filter(dc => dc.rtt <= MAX_PROVISION_RTT_MS)
    }
  }

  const gpus = GPU_CATALOG
    .filter(g => g.pricePerHr <= PRICE_CEILING)
    .sort((a, b) => gpuSortScore(a.pricePerHr, a.gen) - gpuSortScore(b.pricePerHr, b.gen))

  const candidates: GpuCandidate[] = []
  for (const tier of ['near', 'mid', 'far'] as const) {
    // Sort DCs nearest-first within the tier. Each DC gets its own candidate so
    // the broker tries DC1 (nearest) before DC2, etc. Previously all DCs were
    // bundled into one candidate and the datacenterIds array was never forwarded
    // to RunPod — letting RunPod pick any DC worldwide (e.g. France from Florida).
    const sortedDcs = byTier[tier].sort((a, b) => a.rtt - b.rtt)
    if (sortedDcs.length === 0) continue
    for (const dc of sortedDcs) {
      for (const cloudType of CLOUD_TYPES) {
        for (const gpu of gpus) {
          candidates.push({
            gpuKey: gpu.key,
            gpuTypeId: gpu.runpodId,
            gen: gpu.gen,
            pricePerHr: gpu.pricePerHr,
            cloudType,
            datacenterIds: [dc.id],
            tier,
          })
        }
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
}): Promise<ProvisionResult> {
  const candidates = rankCandidates(args.lat, args.lon)
  let attempts = 0
  let bootAttempts = 0
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

        // DC allowlist check: RunPod community cloud often ignores dataCenterIds
        // and places pods wherever it has capacity (EU-SE-1, EU-CZ-1, etc.).
        // We ask RunPod's own GraphQL for the pod's actual dataCenterId and
        // reject any DC not in our catalog (US/CA only). No external API needed.
        // Fail-closed: if RunPod returns null for dataCenterId we can't verify
        // the pod's region — treat as unacceptable and cascade (same as EU-*).
        // Doesn't count against the boot budget — this is RunPod's mistake.
        const inCatalog = addr.dataCenterId != null &&
          RUNPOD_DATACENTERS.some(dc => dc.id === addr.dataCenterId)
        if (!inCatalog) {
          console.warn(`[broker] pod ${podId} landed in ${addr.dataCenterId ?? 'unknown DC'} (not in acceptable DC catalog) — RunPod ignored dataCenterIds, destroying and cascading`)
          try { await provider.destroy(podId) } catch { /* best effort */ }
          lastError = `pod placed in unacceptable datacenter: ${addr.dataCenterId ?? 'unknown'}`
          bootAttempts--
          continue
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

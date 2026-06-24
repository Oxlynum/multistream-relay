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
  MAX_PROVISION_RTT_MS, MAX_RTT_REJECTIONS,
  type Datacenter,
} from '@/lib/datacenters'
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
export function rankCandidates(lat: number, lon: number, needsProfessionalGpu = false): GpuCandidate[] {
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
    .filter(g => !needsProfessionalGpu || !g.consumerGpu)
    .sort((a, b) => gpuSortScore(a.pricePerHr, a.gen) - gpuSortScore(b.pricePerHr, b.gen))

  const candidates: GpuCandidate[] = []
  for (const tier of ['near', 'mid', 'far'] as const) {
    const sortedDcs = byTier[tier].sort((a, b) => a.rtt - b.rtt)
    if (sortedDcs.length === 0) continue
    // Bundle ALL acceptable DCs for this tier into every candidate. RunPod
    // community cloud ignores single-DC requests and places pods wherever it has
    // inventory — but providing the full acceptable list gives it the best chance
    // of landing in the right region. The actual DC is verified by RTT check
    // post-boot. One candidate per GPU type instead of one per DC×GPU: reduces
    // the candidate list from ~275 to ~11 for a typical user, preventing the
    // broker from cycling through hundreds of identical-to-RunPod requests and
    // burning the Vercel 300s function timeout on wrong-region pod detection.
    const dcIds = sortedDcs.map(dc => dc.id)
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
  const candidates = rankCandidates(args.lat, args.lon, needsProfessionalGpu)
  let attempts = 0
  let bootAttempts = 0
  let rttRejections = 0
  let lastError: string | undefined

  // Hard latency rule: the pod RunPod actually gives us must be within this
  // many ms of the user. Proportional floor for users in regions with no nearby
  // DC (e.g. a Pacific island where the nearest DC is 130ms away — we allow
  // 1.5× that rather than permanently failing).
  const minPossibleRttMs = Math.min(
    ...RUNPOD_DATACENTERS.map(dc =>
      estimateRttMs(haversineKm(args.lat, args.lon, dc.lat, dc.lon))
    )
  )
  const rttAcceptanceMs = Math.max(MAX_PROVISION_RTT_MS, minPossibleRttMs * 1.5)

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

        // Hard latency rule: verify the pod's actual DC is close enough to the
        // user. RunPod community cloud routinely ignores dataCenterIds and places
        // pods on whatever continent has spare capacity. We look up the actual DC
        // in our global catalog and reject it if the RTT from the user exceeds
        // rttAcceptanceMs. This works globally — a Swedish user gets EU-SE, a
        // Tokyo user gets AP-JP, etc. Doesn't count against the boot budget.
        // Fail-closed on null/unknown DC: if we can't identify where the pod is,
        // we can't guarantee the latency rule, so we reject it.
        const actualDc = addr.dataCenterId != null
          ? RUNPOD_DATACENTERS.find(dc => dc.id === addr.dataCenterId)
          : null

        if (!actualDc) {
          console.warn(`[broker] pod ${podId} has unrecognized DC ${addr.dataCenterId ?? 'null'} — cannot verify placement, cascading`)
          try { await provider.destroy(podId) } catch { /* best effort */ }
          lastError = `unrecognized datacenter: ${addr.dataCenterId ?? 'null'}`
          bootAttempts--
          continue
        }

        const actualRttMs = estimateRttMs(haversineKm(args.lat, args.lon, actualDc.lat, actualDc.lon))
        if (actualRttMs > rttAcceptanceMs) {
          rttRejections++
          console.warn(`[broker] pod ${podId} placed in ${addr.dataCenterId} (${actualRttMs.toFixed(0)}ms, limit ${rttAcceptanceMs.toFixed(0)}ms) — wrong region (rejection ${rttRejections}/${MAX_RTT_REJECTIONS})`)
          try { await provider.destroy(podId) } catch { /* best effort */ }
          lastError = `pod too far: ${addr.dataCenterId} at ${actualRttMs.toFixed(0)}ms`
          bootAttempts--
          if (rttRejections >= MAX_RTT_REJECTIONS) {
            return { ok: false, attempts, error: `No GPU capacity in your region. RunPod placed ${rttRejections} pods outside your area — try again in a few minutes when local inventory refreshes.` }
          }
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

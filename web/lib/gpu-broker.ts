import net from 'net'

// GPU availability broker.
//
// Model: every provider (RunPod secure today; Vast.ai next) reports a list of
// LOCATION-STAMPED candidates via listCandidates(). The broker merges them into
// one list, ranks by distance-to-user (then price), and creates them nearest-first
// until one boots. Because each candidate carries coordinates and a deterministic
// placement, "closest server wins" spans every provider with no special-casing —
// and there is no post-boot geolocation/region-guessing, because we only use
// providers that place the pod where they said they would.
//
// This replaced the old community-cloud machinery (subregion rings, RTT tiers,
// stock preflight, null-DC handling). All of that existed to clean up after
// RunPod community placing pods globally at random; we no longer use community.

import {
  PRICE_CEILING, READINESS_TIMEOUT_MS, READINESS_POLL_MS, MAX_BOOT_ATTEMPTS,
} from '@/lib/datacenters'
import { ACTIVE_PROVIDERS } from '@/lib/providers/runpod'
import type { GpuCandidate, GpuProvider, PodEnv } from '@/lib/providers/types'
import { requiredNvencSessions, type UserOutputConfig } from '@/lib/nvenc-utils'
export type { UserOutputConfig } from '@/lib/nvenc-utils'

// Stop after this many create attempts even if none succeeded. Capacity misses
// are fast (one rejected API call each), so this bounds a worst case where the
// user's whole region is dry: we try the nearest ~this-many options, then tell
// them to retry rather than booting a pod on another continent.
const MAX_CREATE_ATTEMPTS = 120

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

// TCP probe: verify the RTMP port is actually forwarding before handing the
// address to OBS. RunPod can report a port mapping before the tunnel is wired up;
// this catches broken forwarding so the broker cascades to another pod.
function probeTcp(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(port, host)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error',   () => { clearTimeout(timer); resolve(false) })
  })
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

/** Build the distance-then-price ranked candidate list across all providers. */
async function rankedCandidates(lat: number, lon: number, needsProfessionalGpu: boolean): Promise<Array<{ c: GpuCandidate; distKm: number }>> {
  const lists = await Promise.all(
    ACTIVE_PROVIDERS.map(async p => {
      try {
        return await p.listCandidates({ maxPricePerHr: PRICE_CEILING, needsProfessionalGpu })
      } catch (err) {
        console.error(`[broker] ${p.name} listCandidates failed:`, err instanceof Error ? err.message : err)
        return []
      }
    }),
  )
  return lists
    .flat()
    .map(c => ({ c, distKm: haversineKm(lat, lon, c.lat, c.lon) }))
    .sort((a, b) => a.distKm - b.distKm || a.c.pricePerHr - b.c.pricePerHr)
}

/**
 * Provision the nearest available GPU ≤ PRICE_CEILING. Ranks every provider's
 * candidates by distance and creates nearest-first until one boots; returns the
 * winning pod, or ok:false if the nearest options are exhausted.
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

  const candidates = await rankedCandidates(args.lat, args.lon, needsProfessionalGpu)
  if (candidates.length === 0) {
    return { ok: false, attempts: 0, error: 'no candidates available' }
  }
  const providerByName = new Map(ACTIVE_PROVIDERS.map(p => [p.name, p]))
  const nearest = candidates[0]
  console.log(`[broker] ${candidates.length} candidates across ${ACTIVE_PROVIDERS.length} provider(s); nearest: ${nearest.c.label} (${nearest.distKm.toFixed(0)}km, ${nearest.c.gpuKey} $${nearest.c.pricePerHr})`)

  let attempts = 0
  let bootAttempts = 0
  let lastError: string | undefined

  for (const { c, distKm } of candidates) {
    if (attempts >= MAX_CREATE_ATTEMPTS) {
      console.warn(`[broker] reached ${MAX_CREATE_ATTEMPTS} attempts without capacity near user — giving up`)
      break
    }
    const provider = providerByName.get(c.provider)
    if (!provider) continue
    attempts++

    let podId: string
    let actualCost: number | undefined
    try {
      const created = await provider.create({ candidate: c, name: args.name, imageTag: args.imageTag, env: args.env })
      podId = created.podId
      actualCost = created.costPerHr
    } catch (err) {
      // No capacity in this location/GPU — fast miss, try the next candidate.
      lastError = err instanceof Error ? err.message : String(err)
      console.error(`[broker] ${c.provider} ${c.gpuKey} @ ${c.label} (${distKm.toFixed(0)}km) failed:`, lastError)
      continue
    }

    // Hard price guard: refuse a pod whose live cost exceeds the ceiling.
    if (actualCost !== undefined && actualCost > PRICE_CEILING) {
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = `price ${actualCost} exceeds ceiling ${PRICE_CEILING}`
      continue
    }

    // Got inventory — make sure it actually boots (IP + mapped RTMP port).
    bootAttempts++
    const addr = await waitForIp(provider, podId)
    if (!addr) {
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'pod created but failed to boot'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // The RTMP port must actually be reachable (catches broken tunnels).
    if (!(await probeTcp(addr.ip, addr.port))) {
      console.warn(`[broker] pod ${podId} RTMP ${addr.ip}:${addr.port} unreachable — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'RTMP port unreachable'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // Placement sanity: with a deterministic provider the pod must land where we
    // asked. If it reports a different datacenter than requested (should never
    // happen on RunPod secure), reject it rather than stream from the wrong place.
    const requestedDc = c.placement.datacenterId
    if (addr.dataCenterId && requestedDc && addr.dataCenterId !== requestedDc) {
      console.warn(`[broker] pod ${podId} landed in ${addr.dataCenterId}, expected ${requestedDc} — rejecting`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = `placement mismatch: ${addr.dataCenterId} != ${requestedDc}`
      bootAttempts--   // provider misbehaviour, not a boot failure
      continue
    }

    return {
      ok: true,
      provider: c.provider,
      podId,
      ip: addr.ip,
      port: addr.port,
      hlsPort: addr.hlsPort,
      gpuKey: c.gpuKey,
      datacenter: c.label,
      pricePerHr: actualCost ?? c.pricePerHr,
      attempts,
    }
  }

  return { ok: false, attempts, error: lastError ?? 'no capacity available' }
}

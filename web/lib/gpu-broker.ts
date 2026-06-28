import net from 'net'

// GPU availability broker.
//
// Model: every provider (Vast.ai today; Vultr next) reports a list of
// LOCATION-STAMPED candidates via listCandidates(). The broker merges them into
// one list, ranks by distance-to-user (then price), and creates them nearest-first
// until one boots. Because each candidate carries coordinates and a deterministic
// placement, "closest server wins" spans every provider with no special-casing —
// and there is no post-boot geolocation/region-guessing, because we only use
// providers that place the pod where they said they would.
//
// SRT (UDP) is the only OBS→pod transport, so every active provider must be
// UDP-capable. RunPod was removed — its pods are TCP-only and can't carry SRT.
//
// v1 path: synchronous cascade; returns the winning pod synchronously. Used when
// SLIMCAST_BROKER_V2 is false.
//
// v2 path: startProvisionRace() fans out N pods in parallel and returns immediately;
// pods self-report readiness via POST /api/agent/ready. Used when SLIMCAST_BROKER_V2
// is true.

import {
  PRICE_CEILING, READINESS_TIMEOUT_MS, READINESS_POLL_MS, MAX_BOOT_ATTEMPTS,
} from '@/lib/datacenters'
import { ACTIVE_PROVIDERS } from '@/lib/providers'
import type { GpuCandidate, GpuProvider, PodEnv } from '@/lib/providers/types'
import { requiredNvencSessions, type UserOutputConfig } from '@/lib/nvenc-utils'
export type { UserOutputConfig } from '@/lib/nvenc-utils'

// Stop after this many create attempts even if none succeeded. Capacity misses
// are fast (one rejected API call each), so this bounds a worst case where the
// user's whole region is dry.
const MAX_CREATE_ATTEMPTS = 120

// Phase 0 stopgap: 3→2 retries, 4s→3s delay, 10s→3s per-attempt timeout.
// A live MediaMTX answers an RTMP handshake in <100ms; 3s is generous.
// 2 retries × 3s = 6s max cost vs the old 3 × 4s = 12s per failed pod.
const RTMP_PROBE_RETRIES = 2
const RTMP_PROBE_RETRY_MS = 3000

// Vast container states that mean the pod exited and will never boot.
// Fast-failing on these avoids spinning out the full READINESS_TIMEOUT_MS.
const TERMINAL_STATES = new Set(['exited', 'stopped', 'offline', 'error', 'terminated'])

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
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

// RTMP readiness probe: confirm the pod is actually SERVING RTMP (MediaMTX bound),
// not merely that the port forwards TCP. We do the RTMP handshake (send C0+C1,
// expect S0+S1): only a live RTMP server answers, so this proves the pod is ready.
// Phase 0: default timeout reduced from 10s to 3s (live MediaMTX answers in <100ms).
function probeRtmp(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(port, host)
    let received = 0
    let firstByte = -1
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      const c0c1 = Buffer.alloc(1537)
      c0c1[0] = 0x03
      for (let i = 9; i < 1537; i++) c0c1[i] = (Math.random() * 256) | 0
      socket.write(c0c1)
    })
    socket.on('data', d => {
      if (firstByte < 0 && d.length) firstByte = d[0]
      received += d.length
      if (received >= 1537) done(firstByte === 0x03)
    })
    socket.once('error', () => done(false))
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface PodAddr { ip: string; port: number; hlsPort: number | null; dataCenterId: string | null; srtPort: number | null; udpProbePort: number | null }

/** Poll until the pod reports a public IP + mapped ports (booted), or time out.
 * Phase 0: added fast-fail on terminal Vast container states so a self-exited pod
 * (e.g. GPU self-test failed) is abandoned in ~1 poll instead of at the 110s deadline. */
async function waitForIp(provider: GpuProvider, podId: string): Promise<PodAddr | null> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const s = await provider.getStatus(podId)
      // Fast-fail on any state that means the container exited and won't recover.
      if (TERMINAL_STATES.has(s.status)) {
        console.log(`[broker] pod ${podId} terminal state '${s.status}' — fast-failing`)
        return null
      }
      const ready = s.ip && s.port && s.srtPort   // 8889 (probe) is optional
      if (ready) return { ip: s.ip!, port: s.port!, hlsPort: s.hlsPort ?? null, dataCenterId: s.dataCenterId ?? null, srtPort: s.srtPort ?? null, udpProbePort: s.udpProbePort ?? null }
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
  srtPort?: number | null
  gpuKey?: string
  datacenter?: string
  pricePerHr?: number
  attempts: number
  error?: string
}

/** Build the distance-then-price ranked candidate list across a provider set.
 * Defaults to the all-in-one path (ACTIVE_PROVIDERS, mode 'all-in-one', PRICE_CEILING);
 * the VPS-hub GPU bridge passes ACTIVE_BACKEND_PROVIDERS + mode 'backend' + a higher
 * BACKEND_PRICE_CEILING. */
export async function rankedCandidates(
  lat: number, lon: number, needsProfessionalGpu: boolean,
  opts: { providers?: GpuProvider[]; mode?: 'all-in-one' | 'backend'; maxPricePerHr?: number } = {},
): Promise<Array<{ c: GpuCandidate; distKm: number }>> {
  const providers = opts.providers ?? ACTIVE_PROVIDERS
  const maxPricePerHr = opts.maxPricePerHr ?? PRICE_CEILING
  const mode = opts.mode ?? 'all-in-one'
  const lists = await Promise.all(
    providers.map(async p => {
      try {
        return await p.listCandidates({ maxPricePerHr, needsProfessionalGpu, mode })
      } catch (err) {
        console.error(`[broker] ${p.name} listCandidates failed:`, err instanceof Error ? err.message : err)
        return []
      }
    }),
  )
  return lists
    .flat()
    .map(c => ({ c, distKm: haversineKm(lat, lon, c.lat, c.lon) }))
    .sort((a, b) =>
      (a.c.preferenceTier ?? 0) - (b.c.preferenceTier ?? 0) ||
      a.distKm - b.distKm ||
      a.c.pricePerHr - b.c.pricePerHr)
}

/**
 * v1 broker: Provision the nearest available GPU ≤ PRICE_CEILING. Ranks every
 * provider's candidates by distance and creates nearest-first until one boots;
 * returns the winning pod, or ok:false if the nearest options are exhausted.
 *
 * Phase 0 improvements (all backward-compatible):
 *  - RTMP probe: 3→2 retries, 3s timeout (was 4s delay, 10s timeout) — caps per-pod cost
 *  - waitForIp: fast-fail on terminal Vast states (exited/stopped/offline)
 *  - probeUdp removed from winner path (advisory-only and can't reply from serverless)
 *  - onAddrKnown: saves ip/srtPort to DB right after waitForIp, before probes, so a
 *    mid-cascade Vercel kill can't strand a healthy pod with no saved URL
 */
export async function provisionGpu(args: {
  lat: number
  lon: number
  name: string
  imageTag: string
  env: PodEnv[]
  userOutputs?: UserOutputConfig[]
  onPodCreated?: (podId: string, provider: string) => Promise<void>
  onAddrKnown?: (addr: { ip: string; rtmpPort: number; srtPort: number | null }) => Promise<void>
}): Promise<ProvisionResult> {
  const nvencSessions = args.userOutputs ? requiredNvencSessions(args.userOutputs) : 0
  const needsProfessionalGpu = nvencSessions > 3
  if (needsProfessionalGpu) {
    console.log(`[broker] user needs ${nvencSessions} NVENC sessions — skipping consumer GPUs`)
  }
  const candidates = await rankedCandidates(args.lat, args.lon, needsProfessionalGpu)
  if (candidates.length === 0) {
    return { ok: false, attempts: 0, error: 'no SRT-capable host available right now' }
  }
  const providerByName = new Map(ACTIVE_PROVIDERS.map(p => [p.name, p]))
  const nearest = candidates[0]
  const preferred = candidates.filter(x => (x.c.preferenceTier ?? 0) === 0).length
  console.log(`[broker] ${candidates.length} candidates across ${ACTIVE_PROVIDERS.length} provider(s) (${preferred} good-driver, ${candidates.length - preferred} demoted); nearest: ${nearest.c.label} (${nearest.distKm.toFixed(0)}km, ${nearest.c.gpuKey} $${nearest.c.pricePerHr}, tier${nearest.c.preferenceTier ?? 0})`)

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
      try { await args.onPodCreated?.(podId, c.provider) } catch { /* best effort */ }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.error(`[broker] ${c.provider} ${c.gpuKey} @ ${c.label} (${distKm.toFixed(0)}km) failed:`, lastError)
      continue
    }

    if (actualCost !== undefined && actualCost > PRICE_CEILING) {
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = `price ${actualCost} exceeds ceiling ${PRICE_CEILING}`
      continue
    }

    bootAttempts++
    const addr = await waitForIp(provider, podId)
    if (!addr) {
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'pod created but failed to boot'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // Phase 0: save the URL early — right after IP/port are known, before probes.
    // If this Vercel function is killed mid-probe, the pod's URL is already in the DB
    // and OBS can connect. Previously this save only happened after the broker returned.
    try { await args.onAddrKnown?.({ ip: addr.ip, rtmpPort: addr.port, srtPort: addr.srtPort }) } catch { /* best effort */ }

    let rtmpOk = false
    for (let r = 0; r < RTMP_PROBE_RETRIES; r++) {
      if (await probeRtmp(addr.ip, addr.port)) { rtmpOk = true; break }
      if (r < RTMP_PROBE_RETRIES - 1) await sleep(RTMP_PROBE_RETRY_MS)
    }
    if (!rtmpOk) {
      console.warn(`[broker] pod ${podId} RTMP ${addr.ip}:${addr.port} not serving after ${RTMP_PROBE_RETRIES} tries — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'RTMP not ready (MediaMTX not answering)'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    if (!addr.srtPort) {
      console.warn(`[broker] pod ${podId} SRT port not mapped — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'SRT port not mapped'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // Phase 0: probeUdp removed from the winner path.
    // Rationale: a serverless function can't receive UDP replies (no stable inbound
    // socket), so a no-reply told us nothing about the host. The advisory UDP echo
    // on the pod side still runs; it just never gates readiness here.
    console.log(`[broker] pod ${podId} SRT ready: srt port ${addr.srtPort} mapped`)

    return {
      ok: true,
      provider: c.provider,
      podId,
      ip: addr.ip,
      port: addr.port,
      hlsPort: addr.hlsPort,
      srtPort: addr.srtPort,
      gpuKey: c.gpuKey,
      datacenter: c.label,
      pricePerHr: actualCost ?? c.pricePerHr,
      attempts,
    }
  }

  return { ok: false, attempts, error: lastError ?? 'no capacity available' }
}

// ── v2 broker: parallel race ─────────────────────────────────────────────────

export interface RacerEntry {
  provider: string
  provider_id: string
  state: 'booting' | 'ready' | 'failed' | 'loser'
  machine_id?: number
}

export interface RaceArgs {
  lat: number
  lon: number
  name: string
  imageTag: string
  env: PodEnv[]
  userOutputs?: UserOutputConfig[]
  /** Number of pods to create per race round (default: 2). */
  racersN?: number
  /** Skip the first `skipN` candidates (used for next-round kicks). */
  skipN?: number
  /** Provider set to race over. Defaults to ACTIVE_PROVIDERS (all-in-one); the GPU
   * bridge passes ACTIVE_BACKEND_PROVIDERS. */
  providers?: GpuProvider[]
  /** 'backend' relaxes provider port/UDP filters for the GPU bridge. */
  mode?: 'all-in-one' | 'backend'
  /** Price ceiling for candidate filtering (defaults to PRICE_CEILING). */
  maxPricePerHr?: number
  /**
   * Called immediately after each pod is created (before any further await in
   * this promise chain), so the pod is reapable even if the fan-out is killed
   * mid-flight by Vercel's maxDuration.
   */
  onRacerCreated: (racer: RacerEntry) => Promise<void>
}

export interface RaceResult {
  started: boolean
  racerCount: number
  error?: string
}

/**
 * v2 broker: Fan out N pods in parallel from the ranked candidate list and
 * return immediately. Readiness arrives later via POST /api/agent/ready
 * (pod push-readiness); the caller never waits for probes.
 *
 * The wall-clock cost drops from "sum of serial failures" to "slowest of N
 * boots" — one bad host is harmless instead of a 60–180s tax on every stream.
 */
export async function startProvisionRace(args: RaceArgs): Promise<RaceResult> {
  const { racersN = 2, skipN = 0, userOutputs, providers = ACTIVE_PROVIDERS, mode = 'all-in-one', maxPricePerHr } = args
  const nvencSessions = userOutputs ? requiredNvencSessions(userOutputs) : 0
  // In 'backend' (bridge) mode the GPU does ONE NVENC encode per ORIENTATION (≤2 total) —
  // buildGpuConfig collapses every platform in an orientation into a single spec — so the
  // per-platform session count must NOT demand a professional card here. Counting raw
  // outputs (e.g. a 4-platform combo with distinct bitrates) would falsely set
  // needsProfessionalGpu, exclude every consumer GPU, and degrade an ordinary stream to
  // passthrough-only on a perfectly capable card. (reraceGpuBackend already omits userOutputs.)
  const needsProfessionalGpu = mode === 'backend' ? false : nvencSessions > 3

  const candidates = await rankedCandidates(args.lat, args.lon, needsProfessionalGpu, { providers, mode, maxPricePerHr })
  if (candidates.length === 0) {
    return { started: false, racerCount: 0, error: 'no capable host available' }
  }

  // Deduplicate by physical host so two racers never share the same machine.
  // One broken host shouldn't consume both race slots.
  const seenHostIds = new Set<number>()
  const dedupedCandidates = candidates.filter(({ c }) => {
    const hostId = typeof c.placement.hostId === 'number' ? c.placement.hostId : null
    if (hostId === null) return true
    if (seenHostIds.has(hostId)) return false
    seenHostIds.add(hostId)
    return true
  })

  const providerByName = new Map(providers.map(p => [p.name, p]))
  // Candidate pool past the rounds already tried (skipN). We fan out racersN at a time,
  // but a create FAILURE (RunPod 500 / no-capacity, a drained region) must NOT end the
  // race — fall through to the NEXT ranked host until we have racersN live pods or run
  // out. Without this, a single top-ranked host failing to create aborted the whole race
  // and no other provider was ever attempted (e.g. RunPod failed → Vast never tried).
  // Bounded by MAX_CREATE_ATTEMPTS so we never probe an unbounded number of dead hosts.
  const pool = dedupedCandidates.slice(skipN)
  if (pool.length === 0) {
    return { started: false, racerCount: 0, error: 'no untried candidates remaining' }
  }
  // Create-failure fallthrough is enabled ONLY in 'backend' mode. The all-in-one re-race
  // cascade (agent/failed) computes skipN as (round+1)*2 assuming EXACTLY 2 racers/round;
  // if this loop walked past that window on all-in-one, the next cascade round would
  // re-attempt candidates already tried here (duplicate pods). Backend re-race
  // (reraceGpuBackend) keys off the racers[] array, not that fixed stride, so the
  // fallthrough is safe there — and it's exactly the path that needs it (RunPod→Vast).
  const MAX_CREATE_ATTEMPTS = mode === 'backend' ? racersN + 4 : racersN

  const createOne = async ({ c, distKm }: { c: GpuCandidate; distKm: number }): Promise<boolean> => {
    const provider = providerByName.get(c.provider)
    if (!provider) return false
    try {
      const created = await provider.create({ candidate: c, name: args.name, imageTag: args.imageTag, env: args.env, mode })
      const racer: RacerEntry = {
        provider: c.provider,
        provider_id: created.podId,
        state: 'booting',
        machine_id: typeof c.placement.machineId === 'number' ? c.placement.machineId : undefined,
      }
      // Persist the racer before any further await so it's reapable even if we die here.
      try { await args.onRacerCreated(racer) } catch { /* best effort */ }
      console.log(`[broker/race] created ${c.provider} pod ${created.podId} (${c.gpuKey} @ ${c.label} ${distKm.toFixed(0)}km)`)
      return true
    } catch (err) {
      console.error(`[broker/race] ${c.provider} ${c.gpuKey} @ ${c.label} failed to create:`, err instanceof Error ? err.message : err)
      return false
    }
  }

  let racerCount = 0, attempted = 0, idx = 0
  while (racerCount < racersN && idx < pool.length && attempted < MAX_CREATE_ATTEMPTS) {
    const batch = pool.slice(idx, idx + (racersN - racerCount))
    idx += batch.length
    attempted += batch.length
    const preferred = batch.filter(x => (x.c.preferenceTier ?? 0) === 0).length
    console.log(`[broker/race] fanning out ${batch.length} racer(s) (skip=${skipN}, tried=${attempted}, preferred=${preferred}): ${batch.map(e => e.c.label).join(', ')}`)
    const results = await Promise.allSettled(batch.map(createOne))
    racerCount += results.filter(r => r.status === 'fulfilled' && r.value === true).length
  }

  return { started: racerCount > 0, racerCount }
}

import net from 'net'
import dgram from 'dgram'

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
// Readiness is gated on the RTMP beacon (proves MediaMTX is serving) PLUS the
// SRT + UDP-probe ports being mapped; the UDP echo itself is advisory only.

import {
  PRICE_CEILING, READINESS_TIMEOUT_MS, READINESS_POLL_MS, MAX_BOOT_ATTEMPTS,
} from '@/lib/datacenters'
import { ACTIVE_PROVIDERS } from '@/lib/providers'
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

// RTMP readiness probe: confirm the pod is actually SERVING RTMP (MediaMTX bound),
// not merely that the port forwards TCP. A forwarded/proxied port (esp. on Vast,
// and during a pod's cold start) accepts a TCP connection BEFORE MediaMTX is ready,
// so a bare connect can green-light a pod that can't yet ingest — OBS then fails to
// publish and `streaming` stays false. We do the RTMP handshake (send C0+C1, expect
// S0+S1): only a live RTMP server answers, so this proves the pod is truly ready.
function probeRtmp(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(port, host)
    let received = 0
    let firstByte = -1
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      const c0c1 = Buffer.alloc(1537)   // C0 (1B version) + C1 (1536B)
      c0c1[0] = 0x03                    // RTMP version 3
      for (let i = 9; i < 1537; i++) c0c1[i] = (Math.random() * 256) | 0  // C1 random payload
      socket.write(c0c1)
    })
    socket.on('data', d => {
      if (firstByte < 0 && d.length) firstByte = d[0]
      received += d.length
      if (received >= 1537) done(firstByte === 0x03)   // got S0 (v3) + S1 → MediaMTX is serving
    })
    socket.once('error', () => done(false))
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Vast host probe (SRT mode): the relay runs a UDP echo on 8889/udp that replies
// "ECHO:<status>:<data>" where status is OK | BAD | PENDING (OK = outbound to the
// platforms works; BAD = it can ingest but can't deliver to Twitch).
//
// ADVISORY, not gating. A Vercel/serverless function cannot reliably complete an
// outbound UDP round-trip (no stable inbound path back to the ephemeral socket), so
// a no-reply here tells us nothing about the HOST — it's usually our own egress.
// Gating on it rejected every datacenter host and made SRT impossible. So we only
// act on a DEFINITIVE negative: an explicit ECHO:BAD means the host self-reported
// blocked outbound → reject. Anything else (OK, or — the common case — no reply at
// all) → proceed. UDP forwarding itself is already assured by the datacenter-host
// filter (listCandidates), and the agent's own outbound self-test is the backstop.
// Returns false ONLY on an explicit BAD; true otherwise (including timeout).
function probeUdp(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer); clearInterval(retx)
      try { socket.close() } catch { /* already closed */ }
      resolve(ok)
    }
    // No reply within the window → proceed (true). Only an explicit BAD rejects.
    const timer = setTimeout(() => finish(true), timeoutMs)
    const msg = Buffer.from('slimcast-udp-probe')
    socket.on('message', m => {
      const s = m.toString()
      if (!s.startsWith('ECHO:')) return       // not our responder
      if (s.startsWith('ECHO:OK:')) finish(true)        // udp forwards + outbound works
      else if (s.startsWith('ECHO:BAD:')) finish(false) // host self-reported blocked outbound → reject
      // ECHO:PENDING: → outbound test still running; keep retransmitting until OK/BAD
    })
    socket.on('error', () => finish(true))   // our egress hiccup, not the host — proceed
    socket.send(msg, port, host)
    let n = 0
    const retx = setInterval(() => { if (!done && n++ < 12) socket.send(msg, port, host) }, 1000)
  })
}

interface PodAddr { ip: string; port: number; hlsPort: number | null; dataCenterId: string | null; srtPort: number | null; udpProbePort: number | null }

/** Poll until the pod reports a public IP + mapped ports (booted), or time out.
 * We wait for BOTH the RTMP beacon port (proves MediaMTX answered, mapped TCP) AND
 * the UDP ports (SRT ingest + probe). Vast maps the UDP ports a few seconds AFTER
 * the TCP ones, so returning on the RTMP port alone would make the SRT readiness
 * check see null ports and wrongly reject the pod. */
async function waitForIp(provider: GpuProvider, podId: string): Promise<PodAddr | null> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const s = await provider.getStatus(podId)
      const ready = s.ip && s.port && s.srtPort && s.udpProbePort
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

/** Build the distance-then-price ranked candidate list across all providers. Every
 * active provider is UDP-capable (SRT is the only OBS→pod transport), so there's no
 * protocol filter — all candidates compete uniformly on distance then price. */
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
  // Called the instant a pod is created, BEFORE the slow readiness probes, so the
  // caller can persist provider_id onto the claim row and the pod is reapable even
  // if this function is killed mid-cascade (Vercel maxDuration) — otherwise a pod
  // created during a failed SRT cascade strands with provider_id='' and bills until
  // the daily by-label reaper. Best-effort; must never throw into the broker loop.
  onPodCreated?: (podId: string, provider: string) => Promise<void>
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
      // Record it NOW so it can always be torn down — before any probe that might
      // hang or before this function hits its duration ceiling.
      try { await args.onPodCreated?.(podId, c.provider) } catch { /* best effort */ }
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

    // Got inventory — make sure it actually boots (IP + mapped ports; in SRT mode
    // that includes the UDP ports, which Vast maps a few seconds after the TCP ones).
    bootAttempts++
    const addr = await waitForIp(provider, podId)
    if (!addr) {
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'pod created but failed to boot'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // MediaMTX must actually answer RTMP (not just accept TCP) — proves the pod
    // is truly ready to ingest before we hand the address to OBS.
    if (!(await probeRtmp(addr.ip, addr.port))) {
      console.warn(`[broker] pod ${podId} RTMP ${addr.ip}:${addr.port} not serving yet — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'RTMP not ready (MediaMTX not answering)'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }

    // The host must have MAPPED the SRT + probe ports (verifiable over HTTP via
    // getStatus — a hard requirement; without the SRT port there is no ingest).
    // waitForIp already gates on these; re-check defensively before the UDP probe.
    // The UDP echo is only ADVISORY (see probeUdp): we reject solely on an explicit
    // ECHO:BAD, never on a no-reply, because our own serverless egress can't
    // reliably round-trip UDP and was rejecting every good host.
    if (!addr.srtPort || !addr.udpProbePort) {
      console.warn(`[broker] pod ${podId} SRT/UDP ports not mapped (srt=${addr.srtPort} probe=${addr.udpProbePort}) — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'SRT ports not mapped'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }
    if (!(await probeUdp(addr.ip, addr.udpProbePort))) {
      // Only reached on an explicit ECHO:BAD — the host itself said outbound to
      // the platforms is blocked, so it could ingest but never deliver. Reject.
      console.warn(`[broker] pod ${podId} host self-reported blocked outbound (${addr.ip}:${addr.udpProbePort}) — cascading`)
      try { await provider.destroy(podId) } catch { /* best effort */ }
      lastError = 'host reported blocked outbound-to-platform'
      if (bootAttempts >= MAX_BOOT_ATTEMPTS) return { ok: false, attempts, error: 'too many failed boots' }
      continue
    }
    console.log(`[broker] pod ${podId} SRT ready: srt port ${addr.srtPort} mapped (outbound advisory passed)`)

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

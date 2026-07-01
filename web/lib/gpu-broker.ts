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
// Every GPU is a transcode BACKEND behind a trusted VPS hub. OBS→hub is SRT; the
// hub bridges hub→GPU over mpegts-over-TLS (TCP) on :8899, so a GPU provider only
// needs a single inbound TCP port, and stream keys never reach the GPU. RunPod is a
// first-class GPU-backend provider again — its TCP-only limitation no longer matters
// now that SRT terminates at the hub, not the GPU.
//
// startProvisionRace() fans out N pods in parallel and returns immediately; pods
// self-report readiness via POST /api/agent/ready (the caller never waits for probes).

import { PRICE_CEILING } from '@/lib/datacenters'
import { ACTIVE_GPU_PROVIDERS } from '@/lib/providers'
import { captureError } from '@/lib/observability'
import type { GpuCandidate, GpuProvider, PodEnv } from '@/lib/providers/types'
import type { UserOutputConfig } from '@/lib/nvenc-utils'
export type { UserOutputConfig } from '@/lib/nvenc-utils'

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

/** Build the distance-then-price ranked candidate list across a provider set.
 * Defaults to ACTIVE_GPU_PROVIDERS at PRICE_CEILING; the VPS-hub GPU bridge can pass
 * an explicit provider set + a higher BACKEND_PRICE_CEILING. */
export async function rankedCandidates(
  lat: number, lon: number, needsProfessionalGpu: boolean,
  opts: { providers?: GpuProvider[]; maxPricePerHr?: number } = {},
): Promise<Array<{ c: GpuCandidate; distKm: number }>> {
  const providers = opts.providers ?? ACTIVE_GPU_PROVIDERS
  const maxPricePerHr = opts.maxPricePerHr ?? PRICE_CEILING
  const lists = await Promise.all(
    providers.map(async p => {
      try {
        return await p.listCandidates({ maxPricePerHr, needsProfessionalGpu })
      } catch (err) {
        console.error(`[broker] ${p.name} listCandidates failed:`, err instanceof Error ? err.message : err)
        // TEMP-DIAG (no-gpu investigation): a provider's catalog fetch throwing (e.g. a
        // 401 from a stale key) silently yields [] → the race can find "no capable host".
        // Surface it so ONE re-test tells us if the empty list is auth vs genuinely no offers.
        captureError('broker.listCandidates', err, { provider: p.name, maxPricePerHr, alert: true })
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
  /** Provider set to race over. Defaults to ACTIVE_GPU_PROVIDERS. */
  providers?: GpuProvider[]
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
  const { racersN = 2, skipN = 0, providers = ACTIVE_GPU_PROVIDERS, maxPricePerHr } = args
  // The GPU is always a transcode backend: buildGpuConfig collapses every platform in an
  // orientation into ONE NVENC encode (≤2 total), never per-platform — so a consumer card
  // is always eligible and we never demand a professional GPU here.
  const needsProfessionalGpu = false

  const candidates = await rankedCandidates(args.lat, args.lon, needsProfessionalGpu, { providers, maxPricePerHr })
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
  // Create-failure fallthrough (always on): a create FAILURE (no-capacity / drained
  // region / provider 500) must not end the race — walk to the next ranked host until
  // racersN pods are live or the pool runs out. Safe because the re-race cascade
  // (reraceGpuBackend) keys off the racers[] array, not a fixed per-round stride.
  const MAX_CREATE_ATTEMPTS = racersN + 4

  const createOne = async ({ c, distKm }: { c: GpuCandidate; distKm: number }): Promise<boolean> => {
    const provider = providerByName.get(c.provider)
    if (!provider) return false
    try {
      const created = await provider.create({ candidate: c, name: args.name, imageTag: args.imageTag, env: args.env })
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
      // TEMP-DIAG (no-gpu investigation): per-host create failure carries the EXACT provider
      // rent error (e.g. Vast's "insufficient credit" / offer-taken / body reject). If the key
      // is fine but every create fails, this is where the reason lands.
      captureError('broker.race.create', err, {
        provider: c.provider, gpuKey: c.gpuKey, label: c.label,
        offerId: String((c.placement as { offerId?: unknown }).offerId ?? ''), alert: true,
      })
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

// Tuning surface for the GPU availability broker (lib/gpu-broker.ts).
// Everything here is data, not logic — adjust prices, add datacenters, or change
// the acceptance list without touching the cascade code.

export interface Datacenter {
  id: string          // RunPod datacenter id
  lat: number
  lon: number
}

// RunPod datacenters that the REST `POST /pods` endpoint will actually BUILD a
// community-cloud pod in, with approximate coordinates for proximity ranking.
//
// IMPORTANT — this is the create-valid list, NOT RunPod's full catalog.
// RunPod exposes TWO disagreeing datacenter lists:
//   • GraphQL `dataCenters` query  → ~47 DCs (everything they operate)
//   • REST `POST /pods` enum       → 28 DCs (where community builds are allowed)
// The create endpoint rejects the ENTIRE request (HTTP 400) if the dataCenterIds
// array contains even one DC outside its 28-entry enum. So the REST build-list is
// the only source of truth that matters here — pinning a GraphQL-only DC (e.g.
// US-KS-1, US-MO-2, US-OR-1) hard-fails provisioning. Keep this list in sync with
// the enum RunPod returns in that 400 error; add a DC here only after confirming
// `POST /pods` accepts it. (Coordinates only need to be close enough to rank by
// proximity.)
export const RUNPOD_DATACENTERS: Datacenter[] = [
  // North America — US
  { id: 'US-GA-1', lat: 33.75, lon: -84.39 },  // Atlanta
  { id: 'US-GA-2', lat: 33.75, lon: -84.39 },
  { id: 'US-NC-1', lat: 35.23, lon: -80.84 },  // Charlotte
  { id: 'US-DE-1', lat: 39.16, lon: -75.52 },  // Delaware
  { id: 'US-MD-1', lat: 39.05, lon: -76.64 },  // Maryland
  { id: 'US-IL-1', lat: 41.88, lon: -87.63 },  // Chicago
  { id: 'US-KS-2', lat: 39.05, lon: -95.70 },  // Kansas
  { id: 'US-KS-3', lat: 39.05, lon: -95.70 },
  { id: 'US-TX-1', lat: 32.78, lon: -96.80 },  // Dallas
  { id: 'US-TX-3', lat: 32.78, lon: -96.80 },
  { id: 'US-TX-4', lat: 32.78, lon: -96.80 },
  { id: 'US-CA-2', lat: 37.40, lon: -122.10 }, // Bay Area
  { id: 'US-WA-1', lat: 47.61, lon: -122.33 }, // Seattle
  // North America — Canada
  { id: 'CA-MTL-1', lat: 45.50, lon: -73.57 }, // Montreal
  { id: 'CA-MTL-2', lat: 45.50, lon: -73.57 },
  { id: 'CA-MTL-3', lat: 45.50, lon: -73.57 },
  // Europe
  { id: 'EU-CZ-1',  lat: 50.08, lon:  14.43 }, // Prague
  { id: 'EU-FR-1',  lat: 48.85, lon:   2.35 }, // Paris
  { id: 'EU-NL-1',  lat: 52.37, lon:   4.90 }, // Amsterdam
  { id: 'EU-RO-1',  lat: 44.43, lon:  26.10 }, // Bucharest
  { id: 'EU-SE-1',  lat: 59.33, lon:  18.07 }, // Stockholm
  { id: 'EUR-IS-1', lat: 64.13, lon: -21.93 }, // Reykjavik
  { id: 'EUR-IS-2', lat: 64.13, lon: -21.93 },
  { id: 'EUR-IS-3', lat: 64.13, lon: -21.93 },
  { id: 'EUR-NO-1', lat: 59.91, lon:  10.75 }, // Oslo
  // Asia Pacific
  { id: 'AP-IN-1',  lat: 19.08, lon:  72.88 }, // Mumbai
  { id: 'AP-JP-1',  lat: 35.68, lon: 139.69 }, // Tokyo
  // Oceania
  { id: 'OC-AU-1',  lat: -33.87, lon: 151.21 }, // Sydney
]

export type GpuGen = 'ada' | 'ampere' | 'blackwell'

export interface GpuSpec {
  key: string         // our short key, stored on the instance for observability
  runpodId: string    // RunPod gpuTypeId string
  gen: GpuGen
  pricePerHr: number
  // GeForce consumer cards have a 3-concurrent-session NVENC hardware limit.
  // Workstation/data-center cards (A4000, A5000, L4, A40, RTX PRO, RTX 6000, L40S)
  // have no session cap. Set to true only for GeForce series.
  consumerGpu?: boolean
}

// NVENC-capable cards only. A100/H100/H200/B200 are deliberately excluded —
// data-center compute GPUs have no hardware video encoder and cannot transcode.
// Ordered loosely by price; the broker sorts precisely (cheapest first, with a
// small preference for the newer/better Ada encoder when prices are close).
export const GPU_CATALOG: GpuSpec[] = [
  { key: 'a4000',      runpodId: 'NVIDIA RTX A4000',                gen: 'ampere',    pricePerHr: 0.25 },
  { key: 'a5000',      runpodId: 'NVIDIA RTX A5000',                gen: 'ampere',    pricePerHr: 0.27 },
  { key: 'l4',         runpodId: 'NVIDIA L4',                       gen: 'ada',       pricePerHr: 0.39 },
  { key: 'a40',        runpodId: 'NVIDIA A40',                      gen: 'ampere',    pricePerHr: 0.44 },
  { key: 'rtx3090',    runpodId: 'NVIDIA GeForce RTX 3090',         gen: 'ampere',    pricePerHr: 0.46, consumerGpu: true },
  { key: 'rtxpro4000', runpodId: 'NVIDIA RTX PRO 4000',             gen: 'blackwell', pricePerHr: 0.57 },
  { key: 'rtx4090',    runpodId: 'NVIDIA GeForce RTX 4090',         gen: 'ada',       pricePerHr: 0.69, consumerGpu: true },
  { key: 'rtxpro4500', runpodId: 'NVIDIA RTX PRO 4500',             gen: 'blackwell', pricePerHr: 0.74 },
  { key: 'rtx6000ada', runpodId: 'NVIDIA RTX 6000 Ada Generation', gen: 'ada',       pricePerHr: 0.77 },
  { key: 'l40s',       runpodId: 'NVIDIA L40S',                     gen: 'ada',       pricePerHr: 0.99 },
  { key: 'rtx5090',    runpodId: 'NVIDIA GeForce RTX 5090',         gen: 'blackwell', pricePerHr: 0.99, consumerGpu: true },
]

// --- Broker policy knobs ----------------------------------------------------

// Never auto-provision a card above this hourly price (protects margin if a
// cascade ever reaches the expensive end of the catalog).
export const PRICE_CEILING = 1.00

// Tiny discount (in $/hr terms) applied to Ada cards when sorting, so an Ada
// card is preferred over an Ampere one only when their prices are within ~3¢.
export const ADA_SORT_BONUS = 0.03

// Subregion ring sizes and distance caps for the broker.
// PRIMARY: DCs within PRIMARY_MAX_KM that form the tight local subregion.
//   Cap prevents e.g. Kansas landing in Seattle's ring, or Montreal in London's.
//   Always includes the nearest DC regardless of distance (remote/VPN users).
// SECONDARY: next ring up to SECONDARY_MAX_KM — same continent fallback.
// PRIMARY_MAX_COUNT / SECONDARY_MAX_COUNT cap list size even within the distance.
export const PRIMARY_MAX_KM      = 2000
export const PRIMARY_MAX_COUNT   = 6
export const SECONDARY_MAX_KM    = 5000
export const SECONDARY_MAX_COUNT = 8

// Cloud types tried, in order. COMMUNITY is cheapest, so we try it first; SECURE
// is datacenter-grade with far more reliable inventory (community is routinely
// dry for the mid-tier NVENC cards — L4/A40/A5000) and every SECURE card in our
// catalog still prices under the $1/hr PRICE_CEILING, so it's a safe fallback.
// The per-(gpu,cloud) stock preflight (lib/runpod.ts fetchGpuStock) skips dead
// combos in either tier, and the runtime cost guard enforces the ceiling.
export const CLOUD_TYPES: string[] = ['COMMUNITY', 'SECURE']

// Readiness gate: after a pod is created we poll until it has a public IP
// (i.e. it actually booted). If it never does, we abandon it and try the next
// candidate — "got inventory" is not the same as "it works".
// RunPod cold start: Docker pull (60-90s) + container start (10s) = ~100s.
// 120s gives enough margin. Worst case with 2 boot attempts = 240s < Vercel 300s limit.
export const READINESS_TIMEOUT_MS = 120_000
export const READINESS_POLL_MS = 5_000

// Cap how many pods we'll boot-and-abandon before giving up (capacity misses
// are fast and don't count — only real-but-dead boots do). DC-rejected pods
// (RunPod placed in wrong region) also don't count against this — only true
// boot failures (timeout / RTMP unreachable) do. Set high enough to survive
// RunPod repeatedly misplacing pods in EU before landing on a US DC.
export const MAX_BOOT_ATTEMPTS = 5

// How many times RunPod can place a pod in the wrong region before we give up
// and tell the user to retry later. Each wrong-region pod takes ~90s to detect
// and destroy — 3 rejections = ~270s, safely within Vercel's 300s limit.
export const MAX_RTT_REJECTIONS = 3

// Default location when the request carries no geo headers (local dev, VPNs):
// central US minimizes worst-case latency for an unknown US user.
export const FALLBACK_LAT = 39.0
export const FALLBACK_LON = -95.0

// Maps a RunPod datacenter ID to a user-friendly region name.
// Strips the trailing numeric suffix (e.g. 'US-TX-3' → 'US-TX') for the lookup,
// then falls back to parsing the geographic prefix for any unknown ID.
export function dataCenterToRegion(dcId: string): string {
  const REGION_MAP: Record<string, string> = {
    'US-GA': 'US Southeast', 'US-NC': 'US Southeast',
    'US-DE': 'US East',      'US-MD': 'US East',      'US-PA': 'US East',
    'US-IL': 'US Midwest',
    'US-KS': 'US Midwest',   'US-MO': 'US Midwest',   'US-NE': 'US Midwest',
    'US-TX': 'US South',
    'US-CA': 'US West',      'US-WA': 'US West',      'US-OR': 'US West',
    'CA-MTL': 'Canada East',
    'EU-CZ': 'EU Central',
    'EU-DK': 'EU North',     'EU-SE': 'EU North',     'EUR-IS': 'EU North', 'EUR-NO': 'EU North',
    'EU-FR': 'EU West',      'EU-NL': 'EU West',
    'EU-RO': 'EU East',
    'AP-IN': 'Asia South',
    'AP-JP': 'Asia East',
    'SEA-SG': 'Asia Southeast',
    'OC-AU': 'Australia',
  }

  const regionCode = dcId.replace(/-\d+$/, '')
  if (REGION_MAP[regionCode]) return REGION_MAP[regionCode]

  const PREFIX_MAP: Record<string, string> = {
    US: 'United States', EU: 'Europe', EUR: 'Europe',
    AP: 'Asia Pacific',  CA: 'Canada', AU: 'Australia',
    OC: 'Australia',     SEA: 'Asia Southeast',
  }
  const prefix = dcId.split('-')[0]
  return PREFIX_MAP[prefix] ?? dcId
}

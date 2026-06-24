// Tuning surface for the GPU availability broker (lib/gpu-broker.ts).
// Everything here is data, not logic — adjust prices, add datacenters, or change
// the acceptance list without touching the cascade code.

export interface Datacenter {
  id: string          // RunPod datacenter id
  lat: number
  lon: number
}

// All RunPod datacenters with approximate coordinates. Verified against the
// RunPod dataCenters GraphQL API — add new DCs here as RunPod expands.
// Coordinates only need to be close enough to rank by proximity.
export const RUNPOD_DATACENTERS: Datacenter[] = [
  // North America — US
  { id: 'US-GA-1', lat: 33.75, lon: -84.39 },  // Atlanta
  { id: 'US-GA-2', lat: 33.75, lon: -84.39 },
  { id: 'US-NC-1', lat: 35.23, lon: -80.84 },  // Charlotte
  { id: 'US-NC-2', lat: 35.23, lon: -80.84 },
  { id: 'US-DE-1', lat: 39.16, lon: -75.52 },  // Delaware
  { id: 'US-MD-1', lat: 39.05, lon: -76.64 },  // Maryland
  { id: 'US-PA-1', lat: 40.44, lon: -79.99 },  // Pittsburgh
  { id: 'US-IL-1', lat: 41.88, lon: -87.63 },  // Chicago
  { id: 'US-KS-1', lat: 39.05, lon: -95.70 },  // Kansas
  { id: 'US-KS-2', lat: 39.05, lon: -95.70 },
  { id: 'US-KS-3', lat: 39.05, lon: -95.70 },
  { id: 'US-MO-1', lat: 38.63, lon: -90.20 },  // St. Louis
  { id: 'US-MO-2', lat: 39.10, lon: -94.58 },  // Kansas City
  { id: 'US-NE-1', lat: 41.26, lon: -95.94 },  // Omaha
  { id: 'US-TX-1', lat: 32.78, lon: -96.80 },  // Dallas
  { id: 'US-TX-2', lat: 32.78, lon: -96.80 },
  { id: 'US-TX-3', lat: 32.78, lon: -96.80 },
  { id: 'US-TX-4', lat: 32.78, lon: -96.80 },
  { id: 'US-TX-5', lat: 29.76, lon: -95.37 },  // Houston
  { id: 'US-TX-6', lat: 29.76, lon: -95.37 },
  { id: 'US-CA-1', lat: 37.40, lon: -122.10 }, // Bay Area
  { id: 'US-CA-2', lat: 37.40, lon: -122.10 },
  { id: 'US-WA-1', lat: 47.61, lon: -122.33 }, // Seattle
  { id: 'US-OR-1', lat: 45.52, lon: -122.68 }, // Portland
  { id: 'US-OR-2', lat: 45.52, lon: -122.68 },
  // North America — Canada
  { id: 'CA-MTL-1', lat: 45.50, lon: -73.57 }, // Montreal
  { id: 'CA-MTL-2', lat: 45.50, lon: -73.57 },
  { id: 'CA-MTL-3', lat: 45.50, lon: -73.57 },
  { id: 'CA-MTL-4', lat: 45.50, lon: -73.57 },
  // Europe
  { id: 'EU-CZ-1',  lat: 50.08, lon:  14.43 }, // Prague
  { id: 'EU-DK-1',  lat: 55.68, lon:  12.57 }, // Copenhagen
  { id: 'EU-FR-1',  lat: 48.85, lon:   2.35 }, // Paris
  { id: 'EU-NL-1',  lat: 52.37, lon:   4.90 }, // Amsterdam
  { id: 'EU-RO-1',  lat: 44.43, lon:  26.10 }, // Bucharest
  { id: 'EU-SE-1',  lat: 59.33, lon:  18.07 }, // Stockholm
  { id: 'EU-SE-2',  lat: 59.33, lon:  18.07 },
  { id: 'EUR-IS-1', lat: 64.13, lon: -21.93 }, // Reykjavik
  { id: 'EUR-IS-2', lat: 64.13, lon: -21.93 },
  { id: 'EUR-IS-3', lat: 64.13, lon: -21.93 },
  { id: 'EUR-IS-4', lat: 64.13, lon: -21.93 },
  { id: 'EUR-IS-5', lat: 64.13, lon: -21.93 },
  { id: 'EUR-NO-1', lat: 59.91, lon:  10.75 }, // Oslo
  { id: 'EUR-NO-2', lat: 59.91, lon:  10.75 },
  // Asia Pacific
  { id: 'AP-IN-1',  lat: 19.08, lon:  72.88 }, // Mumbai
  { id: 'AP-JP-1',  lat: 35.68, lon: 139.69 }, // Tokyo
  { id: 'SEA-SG-1', lat:  1.35, lon: 103.82 }, // Singapore
  // Oceania
  { id: 'OC-AU-1',  lat: -33.87, lon: 151.21 }, // Sydney
]

export type GpuGen = 'ada' | 'ampere' | 'blackwell'

export interface GpuSpec {
  key: string         // our short key, stored on the instance for observability
  runpodId: string    // RunPod gpuTypeId string
  gen: GpuGen
  pricePerHr: number
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
  { key: 'rtx3090',    runpodId: 'NVIDIA GeForce RTX 3090',         gen: 'ampere',    pricePerHr: 0.46 },
  { key: 'rtxpro4000', runpodId: 'NVIDIA RTX PRO 4000',             gen: 'blackwell', pricePerHr: 0.57 },
  { key: 'rtx4090',    runpodId: 'NVIDIA GeForce RTX 4090',         gen: 'ada',       pricePerHr: 0.69 },
  { key: 'rtxpro4500', runpodId: 'NVIDIA RTX PRO 4500',             gen: 'blackwell', pricePerHr: 0.74 },
  { key: 'rtx6000ada', runpodId: 'NVIDIA RTX 6000 Ada Generation', gen: 'ada',       pricePerHr: 0.77 },
  { key: 'l40s',       runpodId: 'NVIDIA L40S',                     gen: 'ada',       pricePerHr: 0.99 },
  { key: 'rtx5090',    runpodId: 'NVIDIA GeForce RTX 5090',         gen: 'blackwell', pricePerHr: 0.99 },
]

// --- Broker policy knobs ----------------------------------------------------

// Never auto-provision a card above this hourly price (protects margin if a
// cascade ever reaches the expensive end of the catalog).
export const PRICE_CEILING = 1.00

// Tiny discount (in $/hr terms) applied to Ada cards when sorting, so an Ada
// card is preferred over an Ampere one only when their prices are within ~3¢.
export const ADA_SORT_BONUS = 0.03

// Latency tiers (estimated round-trip ms from the user to the datacenter).
// We exhaust the whole NEAR tier before dropping to MID, then FAR — because
// under ~40ms latency is imperceptible for buffered streaming.
export const LATENCY_NEAR_MS = 40
export const LATENCY_MID_MS = 70

// Cloud types tried, in order. COMMUNITY is cheap; add 'SECURE' here to widen
// availability (more reliable inventory) once the account is set up for it.
export const CLOUD_TYPES: string[] = ['COMMUNITY']

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

// Hard RTT ceiling for provisioning. Any datacenter whose estimated RTT from
// the user exceeds this is excluded from the candidate list and rejected if
// RunPod ignores dataCenterIds and places the pod there anyway. Works globally:
// US users stay in US/CA DCs, EU users stay in EU DCs, AP users stay in AP DCs.
// 100ms covers all of each continent from within it; cross-continental DCs are
// 130ms+ from the other side so they're always excluded.
// If no DC is within this bound (VPN, ship, unusual geo), the broker falls back
// to the nearest available DC with a 1.5× proportional acceptance floor.
export const MAX_PROVISION_RTT_MS = 100

// Default location when the request carries no geo headers (local dev, VPNs):
// central US minimizes worst-case latency for an unknown US user.
export const FALLBACK_LAT = 39.0
export const FALLBACK_LON = -95.0

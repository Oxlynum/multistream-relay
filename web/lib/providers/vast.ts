import type { GpuProvider, GpuCandidate, PodStatus, CreatedPod } from './types'

// Vast.ai provider. Vast is a marketplace: you search live offers (each = a
// specific machine with a known GPU, price, geolocation, bandwidth) and rent one.
// Each offer becomes a location-stamped GpuCandidate, so Vast machines rank by
// distance against RunPod datacenters in the same list — closest wins across both.
//
// Verified against the live API with scripts/test-vast.mjs (offer search) and
// scripts/test-vast-rent.mjs (rent → ports → destroy lifecycle).

const BASE = 'https://console.vast.ai/api/v0'
const VAST_API_KEY = process.env.VAST_API_KEY

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${VAST_API_KEY}`, 'Content-Type': 'application/json' }
}

// compute_cap is (compute capability × 100): Pascal=610, Turing=750, Ampere=860,
// Ada=890, Blackwell=1200. The relay's p6 preset + B-frames + temporal-AQ need
// Turing or newer, so this is the hard floor that drops Pascal/Maxwell cards.
const MIN_COMPUTE_CAP = 750
// Streaming guardrails for a usable host.
const MIN_UPLOAD_MBPS = 50      // multistream fan-out needs real upload headroom
const MIN_DOWNLOAD_MBPS = 300   // host pulls the multi-GB relay image on every rent;
                                // slow download → cold-start blows the readiness window
                                // (verified: 801 Mbps host mapped RTMP in ~83s)
const MIN_RELIABILITY = 0.95    // host uptime score (reliability2)
const MIN_DIRECT_PORTS = 2      // need RTMP (1935) + HLS (8888) mapped

// Bandwidth cost is the make-or-break for a streaming workload: Vast bills per TB
// (RunPod doesn't), and host rates range $0.001–$40/TB. So we price offers ALL-IN
// (GPU + estimated bandwidth) and reject gougers, otherwise the broker would pick
// a "cheap" $0.08 GPU that actually costs $0.86/hr after a $40/TB egress fee.
// Estimated traffic for a typical 4–5 platform 1080p60 fan-out:
const EGRESS_GB_PER_HR = 14     // ~30 Mbps out (landscape tee + YT passthrough + portrait)
const INGRESS_GB_PER_HR = 6     // ~13 Mbps in (OBS → pod)
const MAX_EGRESS_COST_PER_TB = 8  // hard reject: caps bandwidth at ~$0.11/hr regardless of distance

// All-in $/hr = GPU rate + estimated bandwidth cost. Used for the price ceiling
// AND for ranking, so Vast competes with RunPod on true cost, not just GPU price.
function allInPricePerHr(o: VastOffer): number {
  const up = o.internet_up_cost_per_tb ?? 0
  const down = o.internet_down_cost_per_tb ?? 0
  return o.dph_total + (EGRESS_GB_PER_HR / 1000) * up + (INGRESS_GB_PER_HR / 1000) * down
}

interface VastOffer {
  id: number
  gpu_name: string
  compute_cap: number
  dph_total: number
  reliability2: number
  inet_up: number
  inet_down: number
  internet_up_cost_per_tb: number | null
  internet_down_cost_per_tb: number | null
  direct_port_count: number
  public_ipaddr: string | null
  geolocation: string | null
}

// Country-centroid fallback coords (used only if IP geolocation fails). Keyed by
// the 2-letter code at the tail of Vast's geolocation string ("California, US").
const COUNTRY_COORDS: Record<string, [number, number]> = {
  US: [39.8, -98.6], CA: [56.1, -106.3], GB: [54.0, -2.0], DE: [51.2, 10.4],
  FR: [46.6, 2.2], NL: [52.1, 5.3], SE: [60.1, 18.6], NO: [60.5, 8.5],
  FI: [61.9, 25.7], CZ: [49.8, 15.5], SK: [48.7, 19.7], PL: [51.9, 19.1],
  BG: [42.7, 25.5], RO: [45.9, 25.0], ES: [40.4, -3.7], IT: [41.9, 12.6],
  KR: [35.9, 127.8], JP: [36.2, 138.3], CN: [35.9, 104.2], IN: [20.6, 78.9],
  SG: [1.35, 103.8], AU: [-25.3, 133.8], AR: [-38.4, -63.6], BR: [-14.2, -51.9],
  UA: [48.4, 31.2], TR: [39.0, 35.2], AE: [23.4, 53.8], IS: [64.1, -21.9],
}

function countryFallback(geolocation: string | null): { lat: number; lon: number } | null {
  const cc = geolocation?.split(',').pop()?.trim().toUpperCase()
  const c = cc && COUNTRY_COORDS[cc]
  return c ? { lat: c[0], lon: c[1] } : null
}

// Batch-geolocate offer IPs (one call) → city-level coords. ip-api free batch is
// http-only and allows 100 IPs/request. Returns coords aligned to the input; a
// failed lookup (or whole-call failure) yields null so the caller can fall back.
async function geolocateIps(ips: string[]): Promise<Array<{ lat: number; lon: number } | null>> {
  if (ips.length === 0) return []
  try {
    const res = await fetch('http://ip-api.com/batch?fields=status,lat,lon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(6000),   // never let geo stall a provision
    })
    if (!res.ok) return ips.map(() => null)
    const arr = (await res.json()) as Array<{ status: string; lat: number; lon: number }>
    return arr.map(r => (r?.status === 'success' ? { lat: r.lat, lon: r.lon } : null))
  } catch {
    return ips.map(() => null)
  }
}

function gpuKeyOf(name: string): string {
  return 'vast-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export const vastProvider: GpuProvider = {
  name: 'vast',

  async listCandidates({ maxPricePerHr, needsProfessionalGpu, srtMode }) {
    if (!VAST_API_KEY) return []
    // Vast machines are consumer GPUs (3-session NVENC cap on older drivers). For
    // users who need >3 simultaneous encodes we can't guarantee it, so skip Vast.
    if (needsProfessionalGpu) return []

    // datacenter:{eq:true} = Vast's datacenter-grade hosts (the secure-cloud analog
    // of RunPod): clean networking, including working OUTBOUND to the platform
    // ingests (consumer/residential hosts often block it — a pod can receive OBS but
    // fail to deliver to Twitch). ~61 of ~499 offers are datacenter.
    //
    // In SRT mode we WIDEN beyond datacenter to all static-IP hosts (~234 vs ~61 —
    // a static public IP signals real hosting, not residential NAT, so far more
    // likely to have clean outbound) and verify each one end-to-end before committing:
    // the UDP echo probe confirms BOTH UDP-forwarding (for SRT ingest) AND
    // outbound-to-Twitch (the echo's status prefix). The static_ip filter just keeps
    // the broker from wasting boots on hosts that would fail the outbound probe; the
    // probe is the actual guarantee. Net: many more, and far closer, usable hosts.
    const q: Record<string, unknown> = {
      verified: { eq: true }, rentable: { eq: true }, rented: { eq: false },
      num_gpus: { eq: 1 }, dph_total: { lte: maxPricePerHr }, type: 'on-demand',
      order: [['dph_total', 'asc']], limit: 100,
    }
    if (srtMode) q.static_ip = { eq: true }
    else q.datacenter = { eq: true }
    let offers: VastOffer[]
    try {
      const res = await fetch(`${BASE}/bundles?q=${encodeURIComponent(JSON.stringify(q))}`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) })
      if (!res.ok) { console.error(`[vast] offer search → ${res.status}`); return [] }
      offers = ((await res.json()).offers ?? []) as VastOffer[]
    } catch (err) {
      console.error('[vast] offer search failed:', err instanceof Error ? err.message : err)
      return []
    }

    const usable = offers.filter(o =>
      o.compute_cap >= MIN_COMPUTE_CAP &&
      o.reliability2 >= MIN_RELIABILITY &&
      o.inet_up >= MIN_UPLOAD_MBPS &&
      o.inet_down >= MIN_DOWNLOAD_MBPS &&
      o.direct_port_count >= MIN_DIRECT_PORTS &&
      (o.internet_up_cost_per_tb ?? 0) <= MAX_EGRESS_COST_PER_TB &&  // reject bandwidth gougers
      allInPricePerHr(o) <= maxPricePerHr &&                          // all-in, not just GPU
      !!o.public_ipaddr,
    )
    if (usable.length === 0) return []

    const coords = await geolocateIps(usable.map(o => o.public_ipaddr as string))
    const candidates: GpuCandidate[] = []
    usable.forEach((o, i) => {
      const loc = coords[i] ?? countryFallback(o.geolocation)
      if (!loc) return   // can't place it on the map → can't rank it → skip
      candidates.push({
        provider: 'vast',
        gpuKey: gpuKeyOf(o.gpu_name),
        gpuTypeId: o.gpu_name,
        pricePerHr: allInPricePerHr(o),   // GPU + bandwidth, so it ranks on true cost
        lat: loc.lat,
        lon: loc.lon,
        label: `vast:${o.id} ${o.gpu_name} ${o.geolocation ?? ''}`.trim(),
        placement: { offerId: o.id },
      })
    })
    return candidates
  },

  async create({ candidate, name, imageTag, env }): Promise<CreatedPod> {
    const offerId = candidate.placement.offerId as number
    // Vast forwards the ports the IMAGE declares with EXPOSE (a rent-time `ports`
    // param is ignored — verified). The relay Dockerfile EXPOSEs 1935 (RTMP), so
    // that maps automatically; we read the host port back in getStatus.
    const body: Record<string, unknown> = {
      client_id: 'me',
      image: imageTag,
      disk: 15,
      label: name,
      runtype: 'args',                                  // run the image's default CMD
      env: Object.fromEntries(env.map(e => [e.key, e.value])),
    }
    // Private registry pull (e.g. the relay image on ghcr.io). Set VAST_IMAGE_LOGIN
    // to a docker-login string ("-u USER -p TOKEN ghcr.io"); omit if the image is public.
    if (process.env.VAST_IMAGE_LOGIN) body.image_login = process.env.VAST_IMAGE_LOGIN

    const res = await fetch(`${BASE}/asks/${offerId}/`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) })
    const text = await res.text()
    let j: { success?: boolean; new_contract?: number; msg?: string } = {}
    try { j = JSON.parse(text) } catch { /* non-JSON */ }
    if (!res.ok || !j.success || !j.new_contract) {
      throw new Error(`Vast rent ${offerId} → ${res.status}: ${j.msg ?? text.slice(0, 200)}`)
    }
    return { podId: String(j.new_contract), costPerHr: candidate.pricePerHr }
  },

  async getStatus(podId): Promise<PodStatus> {
    // Single-instance endpoint returns { instances: <object> } (the list endpoint
    // returns nothing usable). cur_state is the live status; ports appear once the
    // container is up, Docker-binding shape: { "1935/tcp": [{ HostIp, HostPort }] }.
    const res = await fetch(`${BASE}/instances/${podId}/`, { headers: authHeaders() })
    if (!res.ok) return { status: 'unknown', ip: null, port: null, hlsPort: null, dataCenterId: null }
    const inst = (await res.json()).instances as {
      cur_state?: string; actual_status?: string; public_ipaddr?: string
      ports?: Record<string, Array<{ HostIp: string; HostPort: string }>>
    } | undefined
    if (!inst) return { status: 'terminated', ip: null, port: null, hlsPort: null, dataCenterId: null }
    const ip = inst.public_ipaddr ?? null
    const rtmp = inst.ports?.['1935/tcp']?.[0]?.HostPort
    const hls = inst.ports?.['8888/tcp']?.[0]?.HostPort
    const srt = inst.ports?.['8890/udp']?.[0]?.HostPort       // SRT ingest (UDP)
    const udpProbe = inst.ports?.['8889/udp']?.[0]?.HostPort  // UDP echo for the forwarding check
    return {
      status: inst.cur_state ?? inst.actual_status ?? 'unknown',
      ip: rtmp && ip ? ip : null,      // ready only once the RTMP port is mapped
      port: rtmp ? Number(rtmp) : null,
      hlsPort: hls ? Number(hls) : null,
      dataCenterId: null,              // Vast has no datacenter id; placement is by offer
      srtPort: srt ? Number(srt) : null,
      udpProbePort: udpProbe ? Number(udpProbe) : null,
    }
  },

  async stop(podId): Promise<void> {
    // Vast has no cheap "stop" — destroying is the right teardown (no idle billing).
    await this.destroy(podId)
  },

  async destroy(podId): Promise<void> {
    await fetch(`${BASE}/instances/${podId}/`, { method: 'DELETE', headers: authHeaders() })
  },
}

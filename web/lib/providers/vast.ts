import type { GpuProvider, GpuCandidate, PodStatus, CreatedPod } from './types'

// Vast.ai provider. Vast is a marketplace: you search live offers (each = a
// specific machine with a known GPU, price, geolocation, bandwidth) and rent one.
// Each offer becomes a location-stamped GpuCandidate, so Vast machines rank by
// distance against RunPod datacenters in the same list — closest wins across both.
//
// Verified against the live API with scripts/test-vast.mjs (offer search) and
// scripts/test-vast-rent.mjs (rent → ports → destroy lifecycle).

const BASE_V0 = 'https://console.vast.ai/api/v0'
const BASE_V1 = 'https://console.vast.ai/api/v1'
// Convenience alias for the majority of calls (offer search, create, destroy) which
// are still on v0. Instance status/list migrated to v1 (v0 /instances/ deprecated).
const BASE = BASE_V0
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
const MIN_DIRECT_PORTS = 3      // need RTMP (1935) + SRT (8890/udp) + UDP probe (8889/udp)

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
  machine_id: number
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

// Some Vast hosts attach the GPU at the host level (it shows in Vast's own
// monitoring) but never inject the device into the container: the driver
// libraries mount, yet every NVENC/NVDEC call returns
// "CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected". The whole relay
// pipeline is GPU-only, so such a host can't transcode at all — FFmpeg dies in a
// ~6s restart loop and the user sees an endless "connecting" with nothing
// reaching the platforms. There's no remote signal for this (the pod boots, maps
// ports, and answers probes fine), so the durable defense is the boot-time GPU
// self-test in relay/agent.py — a GPU-blind pod self-terminates before opening
// RTMP, which makes the broker cascade to the next-nearest candidate. This
// denylist is the belt-and-suspenders: machines we've already seen fail are
// skipped at ranking time so we don't keep landing on them. Known bad machines:
//   8914 — RTX 5090 at 198.53.64.194: passes the H.264 NVENC/NVDEC self-test but
//            crash-loops the real HEVC→H264 transcode (exit 218). The "10-bit
//            pixfmt" theory was WRONG — the OBS source is confirmed 8-bit (NV12,
//            Main, bt709), so the original crash predates and is unrelated to any
//            10-bit filter. This board genuinely fails real HEVC decode while
//            passing the H.264 self-test, so the self-test can't catch it — RE-ADDED
//            2026-06-26 after it was mistakenly removed in b10b363.
//   78446 — RTX 4090 at 185.61.165.201: GENUINE GPU-injection failure — NVDEC
//            returns CUDA_ERROR_NO_DEVICE and libnvidia-encode.so.1 fails to load
//            mid-stream even after the self-test passed at boot (2026-06-25).
//   67876 — RTX 4090 at 45.143.122.55 (UK): passed the H.264 self-test but HEVC
//            NVDEC failed on a real OBS stream — exit 255. Same class as 8914.
// Extend via VAST_MACHINE_DENYLIST env (comma-separated machine ids).
// Remove an id once the host is confirmed fixed.
const MACHINE_DENYLIST = new Set<number>([
  8914,   // RTX 5090 198.53.64.194 — H.264 self-test passes, real HEVC transcode crash-loops
  78446,
  67876,
  ...(process.env.VAST_MACHINE_DENYLIST ?? '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite),
])


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

  async listCandidates({ maxPricePerHr, needsProfessionalGpu }) {
    if (!VAST_API_KEY) return []
    // Vast machines are consumer GPUs (3-session NVENC cap on older drivers). For
    // users who need >3 simultaneous encodes we can't guarantee it, so skip Vast.
    if (needsProfessionalGpu) return []

    // datacenter:{eq:true} = Vast's datacenter-grade hosts (the secure-cloud analog
    // of RunPod): clean networking, including working OUTBOUND to the platform
    // ingests (consumer/residential hosts often block it — a pod can receive OBS but
    // fail to deliver to Twitch). ~61 of ~499 offers are datacenter.
    //
    // datacenter:{eq:true} for BOTH modes. We tried widening SRT to all static-IP
    // hosts for proximity, but it backfired: verifying each host means BOOTING it +
    // probing (~60-70s), and the wider pool has many hosts that fail the UDP/outbound
    // probe, so the broker cascades host-by-host and blows the 5-min provision budget.
    // Datacenter hosts pass UDP + outbound on the FIRST try (fast provision), and the
    // only cost — distance — doesn't matter over SRT (its buffer absorbs the jitter).
    // So datacenter is the right pool for SRT too; the per-host probe is still run as
    // a safety net but rarely rejects a datacenter host.
    const q: Record<string, unknown> = {
      verified: { eq: true }, rentable: { eq: true }, rented: { eq: false },
      datacenter: { eq: true },
      num_gpus: { eq: 1 }, dph_total: { lte: maxPricePerHr }, type: 'on-demand',
      order: [['dph_total', 'asc']], limit: 100,
    }
    let offers: VastOffer[]
    try {
      const res = await fetch(`${BASE}/bundles/?q=${encodeURIComponent(JSON.stringify(q))}`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) })
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
      !MACHINE_DENYLIST.has(o.machine_id) &&                          // skip known GPU-blind hosts (by machine)
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
        label: `vast:${o.id} m${o.machine_id} ${o.gpu_name} ${o.geolocation ?? ''}`.trim(),
        placement: { offerId: o.id, machineId: o.machine_id },
      })
    })
    return candidates
  },

  async create({ candidate, name, imageTag, env }): Promise<CreatedPod> {
    const offerId = candidate.placement.offerId as number
    // Port mapping: Vast auto-forwards TCP EXPOSE ports but NOT UDP EXPOSE ports.
    // Verified live: relay image (EXPOSE 1935 8080 8890/udp 8889/udp) → Vast only
    // mapped 1935/tcp and 8080/tcp; 8890/udp and 8889/udp were absent.
    // UDP ports require explicit `-p HOST:CONTAINER/udp` entries in the env dict —
    // Vast passes these as additional `docker run -p` flags. Verified live with
    // nginx:alpine + {"-p 8890:8890/udp":"1","-p 8889:8889/udp":"1"} → both UDP
    // ports appeared in the instance ports dict within ~15s.
    // TCP ports (1935, 8080) come free from EXPOSE; no -p flags needed for them.
    const envDict: Record<string, string> = {
      ...Object.fromEntries(env.map(e => [e.key, e.value])),
      '-p 8890:8890/udp': '1',   // SRT ingest — OBS → pod
      '-p 8889:8889/udp': '1',   // UDP echo probe — broker readiness gate
      // NOTE: the relay Dockerfile already bakes NVIDIA_VISIBLE_DEVICES=all +
      // NVIDIA_DRIVER_CAPABILITIES=compute,video,utility, and a live test proved
      // setting them here too does NOT fix a GPU-blind host — the driver libs
      // mount fine but the device node is never injected on some machines. The
      // real defense is the boot-time GPU self-test in relay/agent.py (fails fast
      // so the broker cascades) plus MACHINE_DENYLIST below. Don't re-add the
      // NVIDIA_* env keys here expecting them to help; they don't.
    }
    const body: Record<string, unknown> = {
      client_id: 'me',
      image: imageTag,
      disk: 15,
      label: name,
      runtype: 'args',                                  // run the image's default CMD
      env: envDict,
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
    // Use the v1 LIST endpoint — /api/v0/instances/ was deprecated by Vast and now
    // returns {"error":"deprecated_endpoint"}, so getStatus silently saw every pod
    // as "terminated" (empty list → inst not found). v1 uses the same instances[]
    // array structure; port keys are identical ('1935/tcp', '8890/udp', etc.).
    const res = await fetch(`${BASE_V1}/instances/`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { status: 'unknown', ip: null, port: null, hlsPort: null, dataCenterId: null }
    const arr = ((await res.json()).instances ?? []) as Array<{
      id: number; cur_state?: string; actual_status?: string; public_ipaddr?: string
      ports?: Record<string, Array<{ HostIp: string; HostPort: string }>>
    }>
    const inst = arr.find(i => String(i.id) === String(podId))
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

  // All our live rentals, as { id: contract-id, name: label }. The label is the
  // `name` we pass at create (`slimcast-<userid8>`), which the reaper matches on.
  // The LIST endpoint returns a usable {instances:[...]} array (unlike the per-id
  // status detail); we only need id + label here, so it's the right call.
  async listInstances(): Promise<Array<{ id: string; name: string }>> {
    if (!VAST_API_KEY) return []
    try {
      const res = await fetch(`${BASE_V1}/instances/`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) })
      if (!res.ok) { console.error(`[vast] list instances → ${res.status}`); return [] }
      const arr = ((await res.json()).instances ?? []) as Array<{ id: number; label?: string | null }>
      return arr.map(i => ({ id: String(i.id), name: i.label ?? '' }))
    } catch (err) {
      console.error('[vast] list instances failed:', err instanceof Error ? err.message : err)
      return []
    }
  },
}

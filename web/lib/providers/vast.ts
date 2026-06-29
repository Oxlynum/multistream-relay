import type { GpuProvider, GpuCandidate, PodStatus, CreatedPod } from './types'
import { ownerOfPodName } from '../managed-identity'

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
// The GPU backend's ONLY public inbound is the hub→GPU mpegts-over-TLS bridge on
// 8899/tcp. Vast maps a container's TCP EXPOSE ports from the host's pool of
// `direct_port_count` forwardable ports (UDP EXPOSE is NOT auto-mapped). The gpu-role
// relay image EXPOSEs exactly ONE TCP port (8899), so we need ≥1 direct port to
// guarantee 8899 is publicly mappable. WITHOUT this floor a 0-direct-port host
// (CGNAT/residential — common in the widened consumer-Ampere pool) wins the race,
// boots, passes the NVENC self-test, but never gets VAST_TCP_PORT_8899 injected → the
// hub can never connect the bridge → transcode stays dark AND the GPU bills uselessly
// (it heartbeats, so it dodges the lease sweeper + cron reaper). If the gpu image ever
// EXPOSEs N TCP ports again, raise this to N (Vast picks WHICH ports map, not us).
// RunPod needs no equivalent: its create() explicitly requests 8899/tcp on SECURE.
const MIN_DIRECT_PORTS = 1

// Bandwidth cost is the make-or-break for a streaming workload: Vast bills per TB
// (RunPod doesn't), and host rates range $0.001–$40/TB. So we price offers ALL-IN
// (GPU + estimated bandwidth) and reject gougers, otherwise the broker would pick
// a "cheap" $0.08 GPU that actually costs $0.86/hr after a $40/TB egress fee.
// Estimated traffic for a typical 4–5 platform 1080p60 fan-out:
const EGRESS_GB_PER_HR = 14     // ~30 Mbps out (landscape tee + YT passthrough + portrait)
const INGRESS_GB_PER_HR = 6     // ~13 Mbps in (OBS → pod)
// Raised from $8 to $40: the original $8 cap cut 85% of the datacenter pool
// (all Turing/Ampere hosts in the US/EU have $12–40/TB egress), leaving only
// 3 non-regressed machines globally (2× A40 in AU, 1× A100 in SI). The all-in
// price ceiling (PRICE_CEILING) already guards against expensive-bandwidth+cheap-GPU
// combos — e.g. a $40/TB host at $0.05 GPU runs $0.61/hr, well under $1. Keeping
// a cap at $40 excludes any future gougers above that tier without stranding the pool.
const MAX_EGRESS_COST_PER_TB = 40

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
  host_id: number
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
  driver_version: string | null
  gpu_frac: number
}

// Fractional GPU sharing rules (2026-06-27):
//
// Consumer GPUs (RTX/GTX) use CUDA MPS time-slicing for fractional sharing. On Vast,
// this fails to properly inject the GPU device into the container (CUDA_ERROR_NO_DEVICE)
// regardless of driver version. Empirically confirmed on Turing+Ampere across drivers
// 550/570/580. Require gpu_frac >= 1.0 for consumer cards.
//
// Data center GPUs (A100, H100, L40, A10, etc.) use hardware MIG partitioning —
// a true hardware partition that injects the device correctly into each container
// AND carries no NVENC session cap. Fractional MIG instances are reliable.
//
// Driver ≥570 NVENC regression (confirmed real but dropped as a hard filter):
// On multi-GPU hosts, driver ≥570 breaks NVENC for all-but-the-last-enumerated GPU.
// This is a container-toolkit bug NOT specific to Ada/Blackwell (our earlier assumption
// was too narrow). However, the boot self-test in agent.py catches it in ~30s and
// calls /api/agent/failed, so the broker cascades quickly. Hard-filtering would
// shrink the pool without meaningfully speeding up provision; the self-test is the gate.
function isDataCenterGpu(name: string): boolean {
  const n = name.toLowerCase()
  return (
    /\ba100\b/.test(n) || /\bh100\b/.test(n) || /\bh200\b/.test(n) ||
    /\bv100\b/.test(n) || /\bl40s?\b/.test(n) || /\bl4\b/.test(n)  ||
    /\ba10\b/.test(n)  || /\ba40\b/.test(n)  || /\ba30\b/.test(n)  ||
    n.includes('a6000') || n.includes('a5000') || n.includes('a4000') ||
    n.includes('tesla') || n.includes('quadro')
  )
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
//   8914 — RTX 5090 at 198.53.64.194: the original exit-218 host. Deliberately
//            LEFT OFF the denylist: its crash was blamed on a "10-bit pixfmt" bug,
//            but the OBS source is confirmed 8-bit (NV12, Main, bt709), so that
//            theory is dead. Keeping 8914 in the pool lets the reverted (no-10-bit)
//            image prove whether the board was ever actually bad. Re-add only if it
//            crash-loops the real transcode again on the clean image.
//   78446 — RTX 4090 at 185.61.165.201: GENUINE GPU-injection failure — NVDEC
//            returns CUDA_ERROR_NO_DEVICE and libnvidia-encode.so.1 fails to load
//            mid-stream even after the self-test passed at boot (2026-06-25).
//   67876 — RTX 4090 at 45.143.122.55 (UK): passed the H.264 self-test but HEVC
//            NVDEC failed on a real OBS stream — exit 255.
// Extend via VAST_MACHINE_DENYLIST env (comma-separated machine ids).
// Remove an id once the host is confirmed fixed.
const MACHINE_DENYLIST = new Set<number>([
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

    // No datacenter:{eq:true} filter: the datacenter pool became all RTX 5090
    // (Blackwell), which fails NVENC-in-container even on whole-GPU rentals. The
    // consumer Ampere/Turing whole-GPU hosts (cc>=750, gpu_frac=1.0) are the viable
    // pool. The GPU is a bridge BACKEND now — it receives mpegts-over-TCP on :8899
    // (free from the Dockerfile EXPOSE), never OBS's SRT/UDP — so there's no UDP port
    // map and no direct-port-count screen; the broker v2 /failed cascade handles the
    // rare host that blocks outbound to the platforms.
    const q: Record<string, unknown> = {
      verified: { eq: true }, rentable: { eq: true }, rented: { eq: false },
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
      o.direct_port_count >= MIN_DIRECT_PORTS &&                     // bridge :8899 must be host-mappable
      (o.internet_up_cost_per_tb ?? 0) <= MAX_EGRESS_COST_PER_TB &&  // reject bandwidth gougers
      allInPricePerHr(o) <= maxPricePerHr &&                          // all-in, not just GPU
      !MACHINE_DENYLIST.has(o.machine_id) &&
      // Data center GPUs (A100/H100/L40/etc.) support hardware MIG — fractional OK.
      // Consumer GPUs (RTX/GTX) use MPS time-slicing which fails CUDA device injection
      // on Vast at gpu_frac < 1.0. Driver ≥570 NVENC regression is caught by self-test.
      (isDataCenterGpu(o.gpu_name) || (o.gpu_frac ?? 1) >= 1.0) &&
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
        label: `vast:${o.id} m${o.machine_id} ${o.gpu_name} drv${o.driver_version ?? '?'} ${o.geolocation ?? ''}`.trim(),
        preferenceTier: 0,
        driverVersion: o.driver_version ?? undefined,
        // Carry the raw cost components so create() can hand them to the pod as
        // env vars — the pod's budget-throttle controller needs the actual GPU rate
        // and per-TB bandwidth prices to compute its live $/hr from /proc/net/dev.
        placement: {
          offerId: o.id,
          machineId: o.machine_id,
          hostId: o.host_id,
          gpuRateUsd: o.dph_total,
          egressUsdPerTb: o.internet_up_cost_per_tb ?? 0,
          ingressUsdPerTb: o.internet_down_cost_per_tb ?? 0,
        },
      })
    })
    return candidates
  },

  async create({ candidate, name, imageTag, env }): Promise<CreatedPod> {
    const offerId = candidate.placement.offerId as number
    // The GPU is a bridge BACKEND: its only ingress is mpegts-over-TCP on :8899,
    // which Vast auto-forwards from the Dockerfile EXPOSE (TCP EXPOSE ports come free,
    // no `-p` flags needed). No UDP port maps — OBS never reaches the GPU directly;
    // the trusted VPS hub is the sole SRT ingest and bridges to the GPU over TCP.
    // Cost inputs for the pod's budget-throttle controller. Only known here (the
    // offer's live prices), so we inject them at create rather than from a static
    // env. The pod combines these with measured /proc/net/dev bytes to compute its
    // real $/hr and throttle quality before crossing SLIMCAST_COST_CEILING_USD
    // (passed through the `env` array from the provision route).
    const gpuRateUsd = Number(candidate.placement.gpuRateUsd ?? 0)
    const egressUsdPerTb = Number(candidate.placement.egressUsdPerTb ?? 0)
    const ingressUsdPerTb = Number(candidate.placement.ingressUsdPerTb ?? 0)
    const envDict: Record<string, string> = {
      ...Object.fromEntries(env.map(e => [e.key, e.value])),
      // Provider-neutral self-identity: the pod reports which provider it is so the
      // bridge-port / self-id reads in relay/agent.py never hardcode a provider's env
      // names (Phase 2, item 5). The pod still reads its mapped port from Vast's own
      // VAST_TCP_PORT_* injection; this just names the provider.
      SLIMCAST_PROVIDER: 'vast',
      SLIMCAST_GPU_RATE_USD: String(gpuRateUsd),
      SLIMCAST_EGRESS_USD_PER_TB: String(egressUsdPerTb),
      SLIMCAST_INGRESS_USD_PER_TB: String(ingressUsdPerTb),
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
    // array structure; port keys are identical ('1935/tcp', '8888/tcp', etc.).
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
    return {
      status: inst.cur_state ?? inst.actual_status ?? 'unknown',
      ip: rtmp && ip ? ip : null,      // ready only once the RTMP port is mapped
      port: rtmp ? Number(rtmp) : null,
      hlsPort: hls ? Number(hls) : null,
      dataCenterId: null,              // Vast has no datacenter id; placement is by offer
    }
  },

  async stop(podId): Promise<void> {
    // Vast has no cheap "stop" — destroying is the right teardown (no idle billing).
    await this.destroy(podId)
  },

  async destroy(podId): Promise<void> {
    await fetch(`${BASE}/instances/${podId}/`, { method: 'DELETE', headers: authHeaders() })
  },

  // OUR live rentals only. Vast's `label` is the `name` we set at create
  // (`slimcast-<userid8>`) — Vast has no separate tag system, so the name prefix IS the
  // ownership filter (managed-identity.POD_PREFIX). FILTERING HERE IS LOAD-BEARING: the
  // reaper destroys whatever this returns that has no DB row, so an unrelated box in the
  // account must never appear. `ownerId` is the 8-char user prefix for the reaper's
  // mid-provision guard.
  async listInstances(): Promise<Array<{ id: string; name: string; ownerId: string | null }>> {
    if (!VAST_API_KEY) return []
    try {
      const res = await fetch(`${BASE_V1}/instances/`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) })
      if (!res.ok) { console.error(`[vast] list instances → ${res.status}`); return [] }
      const arr = ((await res.json()).instances ?? []) as Array<{ id: number; label?: string | null }>
      return arr
        .map(i => ({ id: String(i.id), name: i.label ?? '' }))
        // ownerOfPodName != null is hub-EXCLUSIVE: it excludes non-slimcast boxes AND hub
        // names (HUB_PREFIX startsWith POD_PREFIX, so a raw prefix test would let a hub
        // through with ownerId=null → the reaper's GPU pass would destroy it). This also
        // guarantees the emitted ownerId is non-null, closing the reaper guard-skip path.
        .filter(i => ownerOfPodName(i.name) != null)
        .map(i => ({ ...i, ownerId: ownerOfPodName(i.name) }))
    } catch (err) {
      console.error('[vast] list instances failed:', err instanceof Error ? err.message : err)
      return []
    }
  },
}

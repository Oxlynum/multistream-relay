import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'
import { spendableTokens } from '@/lib/billing'
import { FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'

// OBS→hub SRT receive buffer — DYNAMIC per-RTT (enterprise-audit STREAM-01; made per-RTT 2026-07-01).
//
// `latency=` on the OBS/libsrt CALLER is parsed in MICROSECONDS on the builds in use (libsrt
// 1.5.2, confirmed live: latency=2_000_000 gave a healthy 2 s buffer, RTT ~135 ms, 0% drop).
// SRT negotiates effective = MAX(caller, listener); MediaMTX's default is ~120 ms, so the value
// set here is the floor. We size it per-user from the great-circle distance between the CALLER
// (Vercel IP geo) and the HUB (vps_hubs.lat/lon): clamp(4×RTT, 0.8–4 s). 4×RTT is the SRT
// retransmit rule of thumb; over-buffering only adds delay (platforms buffer seconds downstream),
// so a generous estimate is safe. This is the ONLY external SRT leg — OBS→hub; the hub→GPU bridge
// is TCP. The server is the SINGLE writer of `latency=`, so the layers never fight.
//
// CAVEAT: a newer FFmpeg/libsrt build flips this option to MILLISECONDS — if OBS is upgraded,
// RE-CONFIRM the unit (read the negotiated value off MediaMTX) before trusting these numbers.
// FOLLOW-UP: refine with the plugin's MEASURED libsrt `RTT [..ms]` stat (needs a plugin build).
const SRT_LATENCY_FALLBACK_US = 2_000_000   // used when the hub's geo is unknown
const SRT_LATENCY_MIN_US = 800_000          // 0.8 s floor
const SRT_LATENCY_MAX_US = 4_000_000        // 4 s cap

// Great-circle km (mirrors lib/gpu-broker haversineKm; inlined to keep this hot poll route
// dependency-light — no provider/broker module graph pulled into every /status call).
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// Estimate the OBS→hub SRT buffer (µs) from caller↔hub distance. RTT_ms ≈ 15 (edge/processing)
// + 0.02·km (fiber RTT ≈ 0.01 ms/km × ~2 for real-world routing; calibrated to a measured 135 ms
// over ~6500 km). clamp(4×RTT, 0.8–4 s). Fixed fallback when the hub coords are unknown.
function srtLatencyUs(userLat: number, userLon: number, hubLat: number | null, hubLon: number | null): number {
  if (hubLat == null || hubLon == null) return SRT_LATENCY_FALLBACK_US
  const rttMs = 15 + haversineKm(userLat, userLon, hubLat, hubLon) * 0.02
  const latencyUs = Math.round(4 * rttMs * 1000)
  return Math.min(SRT_LATENCY_MAX_US, Math.max(SRT_LATENCY_MIN_US, latencyUs))
}

// Polled by the OBS plugin (user API key) to check GPU state.
// Also accepts a Supabase session token for the dashboard.
export async function GET(request: Request) {
  const supabase = createServerClient()
  let userId: string | null = null

  // Try agent/dock API key first.
  userId = await authenticateAgent(request)

  // Fall back to Supabase session (dashboard).
  if (!userId) {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token)
      userId = user?.id ?? null
    }
  }

  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('status, ip_address, ingest_port, hls_port, srt_port, ingest_key, srt_passphrase, last_seen_at, burn_rate, outputs, streaming, max_session_at, datacenter, gpu_type, topology, vps_hub_id')
    .eq('user_id', userId)
    .maybeSingle()

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits, allotment_tokens, has_2k_addon')
    .eq('id', userId)
    .single()

  // 2K entitlement — the dock compares this against OBS's output resolution to warn
  // when a user pushes a >1080p source without the add-on (it'd just be downscaled).
  const has2kAddon = profile?.has_2k_addon ?? false

  // Dock "time left" must reflect total spendable = allotment (subscribers) + purchased,
  // else a streaming subscriber's remaining time understates by their allotment.
  const credits = spendableTokens(profile)

  if (!instance) {
    return Response.json({
      status: 'stopped',
      ip: null,
      rtmp_url: null,
      srt_url: null,
      ingest_key: null,
      credits,
      credits_seconds: Math.round(credits * 3600),
      burn_rate: 0,
      streaming: false,
      outputs: [],
      confirm_required: false,
      confirm_deadline: null,
      datacenter: null,
      gpu_type: null,
      has_bridge: false,
      has_2k_addon: has2kAddon,
    })
  }

  // "Still streaming?" prompt: within the final 30m before max_session_at, ask
  // the dock to confirm. Confirming (POST /api/agent/confirm-session) pushes the
  // deadline out; ignoring it lets the heartbeat hard-kill at the deadline.
  const CONFIRM_WINDOW_MS = 30 * 60 * 1000
  const maxSessionAt = instance.max_session_at ? new Date(instance.max_session_at).getTime() : null
  const confirmRequired =
    instance.status === 'running' &&
    (instance.streaming ?? false) &&
    !!maxSessionAt &&
    maxSessionAt - Date.now() <= CONFIRM_WINDOW_MS

  // Consider the agent stale if it hasn't checked in for 30s.
  const lastSeen = instance.last_seen_at ? new Date(instance.last_seen_at) : null
  const stale = !lastSeen || (Date.now() - lastSeen.getTime() > 30_000)
  const effectiveStatus = instance.status === 'running' && stale ? 'provisioning' : instance.status

  // RTMP ingest URL: pod IP + provider-mapped public port + per-pod secret path.
  const server = instance.ip_address && instance.ingest_port
    ? `rtmp://${instance.ip_address}:${instance.ingest_port}`
    : null
  // Dynamic OBS→hub SRT buffer (µs), sized per-user from caller↔hub great-circle distance
  // (see srtLatencyUs). The GPU-bridge return is TCP, so OBS→hub is the only SRT leg. One
  // extra light PK read of the hub's coords, and only when there's actually an SRT uplink.
  let srtLatencyMicros = SRT_LATENCY_FALLBACK_US
  if (instance.ip_address && instance.srt_port && instance.ingest_key) {
    const userLat = Number(request.headers.get('x-vercel-ip-latitude')) || FALLBACK_LAT
    const userLon = Number(request.headers.get('x-vercel-ip-longitude')) || FALLBACK_LON
    let hubLat: number | null = null
    let hubLon: number | null = null
    if (instance.vps_hub_id) {
      const { data: hub } = await supabase
        .from('vps_hubs').select('lat, lon').eq('id', instance.vps_hub_id).maybeSingle()
      hubLat = (hub?.lat as number | null) ?? null
      hubLon = (hub?.lon as number | null) ?? null
    }
    srtLatencyMicros = srtLatencyUs(userLat, userLon, hubLat, hubLon)
  }
  // SRT uplink: when the pod has an SRT port, the plugin publishes SRT (not RTMP). The
  // streamid carries the per-pod ingest path (publish:<key>) — routes the publish AND gates
  // access. latency is in microseconds (see srtLatencyUs above). When the pod has a per-pod
  // passphrase, append it so OBS publishes an AES-encrypted uplink (MediaMTX requires the
  // same passphrase to accept it).
  const srtUrl = instance.ip_address && instance.srt_port && instance.ingest_key
    ? `srt://${instance.ip_address}:${instance.srt_port}?streamid=publish:${instance.ingest_key}&latency=${srtLatencyMicros}` +
      (instance.srt_passphrase ? `&passphrase=${instance.srt_passphrase}&pbkeylen=16` : '')
    : null
  // Do NOT log any part of ingest_key — it is the SRT/RTMP publish credential and this
  // line runs on every dock poll (SEC-04). A boolean presence flag is enough to debug.
  console.log(`[gpu/status] effectiveStatus=${effectiveStatus} streaming=${instance.streaming} ip=${instance.ip_address} port=${instance.ingest_port} hls_port=${instance.hls_port ?? 'null'} srt_port=${instance.srt_port ?? 'null'} has_key=${!!instance.ingest_key} rtmp_url=${server}`)

  return Response.json({
    status: effectiveStatus,
    ip: instance.ip_address ?? null,
    rtmp_url: server,
    srt_url: srtUrl,
    ingest_key: instance.ingest_key ?? null,
    credits,
    credits_seconds: Math.round(credits * 3600),
    // Zero the meter when the agent is stale/stopped so the UI doesn't show a
    // burn rate for a stream that isn't actually running.
    burn_rate: effectiveStatus === 'running' ? (instance.burn_rate ?? 0) : 0,
    // Per-platform live state for status dots. Stale/stopped pods aren't live.
    streaming: effectiveStatus === 'running' ? (instance.streaming ?? false) : false,
    outputs: effectiveStatus === 'running' ? (instance.outputs ?? []) : [],
    // The dock shows a countdown + "Yes, still streaming" button when this is set.
    confirm_required: confirmRequired,
    confirm_deadline: instance.max_session_at ?? null,
    // Shown in the dashboard stream manager.
    datacenter: instance.datacenter ?? null,
    gpu_type: instance.gpu_type ?? null,
    // True when the pod has a mapped HLS port — enables the preview player.
    hls_available: effectiveStatus === 'running' && !!instance.hls_port,
    // (ARCH-01/UX-06, removed 2026-06-30): the budget-throttle payload —
    // suggested_ingest_kbps / throttle_tier / throttle_active — was deleted. The hub
    // BudgetController that would set them is deferred (CLAUDE.md §9a), so they were never
    // written and the dock's "quality auto-adjusted" path could never fire. cost_usd_hr was
    // also dropped here: it's parsed but never rendered by the dock (dead surface); the live
    // column stays on gpu_instances for the reaper's cost digest. Re-add all four when the
    // hub throttle + a real dock cost banner return.
    // This stream transcodes via a GPU backend behind the VPS hub → the dock offers a
    // "GPU bridge" health series (direction='bridge'). False for all-in-one + passthrough.
    has_bridge: effectiveStatus === 'running' && instance.topology === 'vps_gpu',
    // 2K entitlement — drives the dock's "2K needs the add-on" resolution warning.
    has_2k_addon: has2kAddon,
  })
}

import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'
import { spendableTokens } from '@/lib/billing'

// OBS→hub SRT receive buffer, in MICROSECONDS (enterprise-audit STREAM-01).
//
// The `latency=` URL option on the OBS/libsrt CALLER is parsed in microseconds on the
// builds in use — so the old `latency=5000` was a 5 MILLISECOND buffer, not the "5s" the
// comment claimed. Evidence: a live transatlantic session (RTT 140–324 ms) broke its SRT
// link at ~12 min — the signature of a buffer below one RTT (a retransmit can't complete
// before the TSBPD delivery deadline). 2_000_000 µs = 2 s is a generous interim that sits
// well above the worst-case RTT; over-buffering only adds delay, and every platform buffers
// seconds downstream, so the extra latency is invisible to viewers.
//
// SRT negotiates the effective latency = MAX(caller, listener), so setting the caller here
// pins the floor regardless of MediaMTX's default. CAVEAT: a newer FFmpeg patch flips this
// option to milliseconds — if the OBS/ffmpeg build is ever upgraded, RE-CONFIRM the unit
// (read the negotiated value off MediaMTX) before trusting this constant, or 2_000_000 ms
// would be a 33-min buffer. TODO (P1): make this per-RTT dynamic — clamp(4×RTT, 0.8–4 s) —
// driven by the libsrt `RTT [..ms]` stat the plugin already sees.
const SRT_LATENCY_US = 2_000_000

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
    .select('status, ip_address, ingest_port, hls_port, srt_port, ingest_key, srt_passphrase, last_seen_at, burn_rate, outputs, streaming, max_session_at, datacenter, gpu_type, topology')
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
  // SRT uplink: when the pod has an SRT port, the plugin should publish SRT instead
  // of RTMP. The streamid carries the per-pod ingest path (publish:<key>), so the
  // key both routes the publish and gates access — same secret as the RTMP path.
  // latency is in microseconds (see SRT_LATENCY_US above for the unit rationale); SRT
  // negotiates MAX(caller,listener) and OBS is the caller. When the pod has a per-pod
  // passphrase, append it so OBS publishes an AES-encrypted uplink (MediaMTX requires
  // the same passphrase to accept it).
  const srtUrl = instance.ip_address && instance.srt_port && instance.ingest_key
    ? `srt://${instance.ip_address}:${instance.srt_port}?streamid=publish:${instance.ingest_key}&latency=${SRT_LATENCY_US}` +
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

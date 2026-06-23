import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

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
    .select('status, ip_address, ingest_port, hls_port, ingest_key, last_seen_at, burn_rate, outputs, streaming, max_session_at, datacenter, gpu_type')
    .eq('user_id', userId)
    .maybeSingle()

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  if (!instance) {
    return Response.json({
      status: 'stopped',
      ip: null,
      rtmp_url: null,
      ingest_key: null,
      credits_seconds: profile?.streaming_credits_seconds ?? 0,
      burn_rate: 0,
      streaming: false,
      outputs: [],
      confirm_required: false,
      confirm_deadline: null,
      datacenter: null,
      gpu_type: null,
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

  // OBS server is the pod IP + the RunPod-mapped public port; the stream key is
  // the per-pod secret (the RTMP path). Both are needed and set by the plugin.
  const server = instance.ip_address && instance.ingest_port
    ? `rtmp://${instance.ip_address}:${instance.ingest_port}`
    : null
  console.log(`[gpu/status] effectiveStatus=${effectiveStatus} ip=${instance.ip_address} port=${instance.ingest_port} key=${instance.ingest_key ? instance.ingest_key.slice(0,8)+'…' : 'null'} rtmp_url=${server}`)

  return Response.json({
    status: effectiveStatus,
    ip: instance.ip_address ?? null,
    rtmp_url: server,
    ingest_key: instance.ingest_key ?? null,
    credits_seconds: profile?.streaming_credits_seconds ?? 0,
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
  })
}
